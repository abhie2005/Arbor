output "url" {
  description = "Where the app is. HTTP until certificate_arn is set."
  value       = var.certificate_arn == "" ? "http://${aws_lb.main.dns_name}" : "https://${aws_lb.main.dns_name}"
}

output "alb_dns_name" {
  description = "The ALB hostname, for the CNAME a real domain points at."
  value       = aws_lb.main.dns_name
}

output "ecr_web_repository" {
  description = "Push the runner image here."
  value       = aws_ecr_repository.web.repository_url
}

output "ecr_migrator_repository" {
  description = "Push the migrator image here."
  value       = aws_ecr_repository.migrator.repository_url
}

output "region" {
  description = "Echoed back so the deploy commands can read it instead of repeating it."
  value       = var.region
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migrator_task_family" {
  description = "Pass to `aws ecs run-task` before deploying a new image."
  value       = aws_ecs_task_definition.migrator.family
}

output "private_subnet_ids" {
  description = "Needed in the `aws ecs run-task` network configuration."
  value       = aws_subnet.private[*].id
}

output "tasks_security_group_id" {
  description = "Needed in the `aws ecs run-task` network configuration."
  value       = aws_security_group.tasks.id
}

output "database_endpoint" {
  description = "RDS address. Reachable only from the tasks security group."
  value       = aws_db_instance.main.address
}

output "database_secret_arn" {
  description = <<-EOT
    The secret holding DATABASE_URL. The ARN is not sensitive; the value is, and
    is not output — read it with
    `aws secretsmanager get-secret-value --secret-id <arn>` if you must.
  EOT
  value       = aws_secretsmanager_secret.database_url.arn
}
