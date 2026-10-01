/**
 * RDS Postgres, and the one secret in this environment.
 *
 * **The password is generated and never passed in.** A `db_password` variable
 * would live in a tfvars file, a shell history and a CI secret, and the whole
 * point of Secrets Manager is that it lives in one place. Terraform state still
 * contains it — state is sensitive material regardless, which is the other
 * reason the S3 backend in versions.tf sets `encrypt`.
 *
 * **What is stored is the whole `DATABASE_URL`, not the password.** The app
 * reads exactly one connection variable (`packages/db/src/client.ts`), so
 * handing it a URL is handing it everything it needs; a task that assembled the
 * URL from five injected parts would be five chances to assemble it differently
 * from the migration task.
 *
 * `sslmode=require` is in the URL because `force_ssl` is on in the parameter
 * group below. Verified against the pinned `pg-connection-string`: with no
 * `sslrootcert` alongside it, `require` sets `rejectUnauthorized = false` — the
 * connection is **encrypted but the certificate is not verified**, which is
 * libpq's meaning of the word and the same posture `createPool({ ssl: true })`
 * already takes in the app. It stops a passive listener on the wire; it does
 * not stop something that can impersonate the database's address inside the
 * VPC. Closing that gap means shipping the Amazon RDS CA bundle in the image
 * and moving to `verify-full`, which is recorded as a gap rather than done here.
 */

resource "random_password" "db" {
  length = 32
  # RDS rejects '/', '@', '"' and space in a master password; excluding the
  # punctuation that also needs URL-escaping keeps the connection string
  # assemblable without an encoder.
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name }
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg17"
  family = "postgres17"

  # Refuse unencrypted connections at the server, rather than trusting every
  # client to ask for TLS. The app's pool does ask (`sslmode=require`), and this
  # is what makes that non-optional for anything else that ever connects.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Arbor's live updates are Postgres LISTEN/NOTIFY (ADR 3, D-090), so a
  # connection is held open per task for notifications in addition to the pool.
  # Left at the default here as a marker: if `max_connections` ever needs
  # raising, that is the reason, not the pool size.

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier = local.name

  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  # gp3 with a ceiling, so a full disk is a bill rather than an outage.
  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  multi_az               = var.db_multi_az

  # Not publicly accessible, and in a private subnet: two answers to the same
  # question, because either one alone is a checkbox somebody can flip.
  publicly_accessible = false

  backup_retention_period    = 7
  backup_window              = "04:00-05:00"
  maintenance_window         = "sun:05:00-sun:06:00"
  auto_minor_version_upgrade = true

  deletion_protection = var.db_deletion_protection
  # A final snapshot on destroy, named for when it happened so two destroys do
  # not collide on the identifier.
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  # Off by default, and not as a cost decision: Performance Insights is not
  # supported on the burstable micro and small classes, so leaving it on would
  # make the very first `apply` fail against the default `db.t4g.micro` with an
  # error about the instance class that reads like a quota problem.
  performance_insights_enabled = var.db_performance_insights

  enabled_cloudwatch_logs_exports = ["postgresql"]

  lifecycle {
    # The snapshot name contains a timestamp, which changes on every plan and
    # would otherwise show as a pending replacement forever.
    ignore_changes = [final_snapshot_identifier]
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${local.name}/database-url"
  description = "The one connection variable the app reads"

  # Zero, because this secret is recreated by terraform rather than rotated by
  # hand: the default seven-day window makes `terraform apply` fail on the name
  # still being held by a deleted secret.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=require",
    var.db_username,
    urlencode(random_password.db.result),
    aws_db_instance.main.address,
    aws_db_instance.main.port,
    var.db_name,
  )
}
