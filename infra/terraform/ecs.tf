/**
 * The cluster, the service, and the one-off migration task.
 *
 * **Two roles, and the distinction is load-bearing.** The *execution* role is
 * used by the ECS agent before the container starts — pulling the image, and
 * reading the secret to inject it. The *task* role is what the application
 * itself would use to call AWS APIs, and Arbor calls none: it talks to Postgres
 * and nothing else. So the task role exists with no policies attached, which is
 * deliberate rather than unfinished — it is the thing to attach to when a
 * feature finally needs S3, and giving it permissions now would be granting
 * them to code that cannot use them.
 */

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name}/web"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "migrator" {
  name              = "/ecs/${local.name}/migrator"
  retention_in_days = 30
}

# --- roles --------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Reading the secret is not in the managed policy, and it is scoped to this one
# secret rather than to Secrets Manager: the execution role is the most widely
# assumed role in the environment.
data "aws_iam_policy_document" "read_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.database_url.arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "read-database-url"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secret.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  description        = "Intentionally has no policies: the app calls no AWS API."
}

# --- the app ------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    # Matches the Dockerfile's note about building for linux/amd64. Change both
    # or neither: an arm64 task definition pulling an amd64 image fails with an
    # exec format error that reads like a corrupt image.
    cpu_architecture = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "web"
    image     = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
    ]

    # The only secret, injected by the agent rather than baked in. `loadRootEnv`
    # uses `override: false`, so a real environment variable always wins over a
    # `.env` file — which is why the image must not contain one (.dockerignore).
    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = aws_secretsmanager_secret.database_url.arn
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.web.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "web"
      }
    }

    # Container-level health check as well as the target group's. The ALB's
    # decides whether to send traffic; this one decides whether ECS replaces the
    # task. A container that can serve HTTP but cannot reach Postgres should be
    # replaced, not merely taken out of rotation.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets = aws_subnet.private[*].id
    # Private subnets with a NAT route, so no public IP is needed or wanted.
    assign_public_ip = false
    security_groups  = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  # The app needs ~1s to be ready and the image pull dominates; this stops ECS
  # counting the startup window as a health-check failure and looping.
  health_check_grace_period_seconds = 60

  deployment_circuit_breaker {
    enable = true
    # Roll back automatically. Without it a broken image leaves the service
    # cycling tasks until somebody notices, which is longer than it sounds.
    rollback = true
  }

  # 100/200 with two tasks: start the new ones before stopping the old, so a
  # deploy is not a window with half the capacity.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  depends_on = [aws_lb_listener.http]

  # No `ignore_changes` on task_definition, deliberately: the revision is
  # terraform's business here, so `var.image_tag` is the single place a deployed
  # version is named. A pipeline that called `update-service` itself would need
  # that ignored, and then the plan would stop telling you what is running.
}

# --- migrations ---------------------------------------------------------------
#
# Not a service: it runs once, exits, and must finish before the new app image
# is serving. Registered here and invoked with `aws ecs run-task` — see
# infra/terraform/README.md for the exact command and why it is not wired into
# `terraform apply` (a migration is a deploy step, and terraform is not a
# deploy tool; making apply run it would make every plan look like a migration).

resource "aws_ecs_task_definition" "migrator" {
  family                   = "${local.name}-migrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrator"
    image     = "${aws_ecr_repository.migrator.repository_url}:${var.image_tag}"
    essential = true

    environment = [{ name = "NODE_ENV", value = "production" }]

    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = aws_secretsmanager_secret.database_url.arn
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrator.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}
