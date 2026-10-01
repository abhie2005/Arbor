variable "region" {
  description = "AWS region. Everything here is regional; nothing assumes us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name, used in every resource name and tag."
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "The VPC range. /16 leaves room for the /20 subnets below."
  type        = string
  default     = "10.20.0.0/16"
}

variable "azs" {
  description = <<-EOT
    Availability zones. Two, because an ALB requires subnets in at least two and
    an RDS subnet group does too — one AZ is not a deployable configuration
    rather than a cheaper one.
  EOT
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.azs) >= 2
    error_message = "An ALB and an RDS subnet group each need at least two availability zones."
  }
}

# --- the app ------------------------------------------------------------------

variable "image_tag" {
  description = <<-EOT
    The tag to deploy, in both ECR repositories. Deliberately not "latest":
    a mutable tag makes a rollback unexpressible, because the thing you would
    roll back to has been overwritten. Use the commit sha.
  EOT
  type        = string
  default     = "bootstrap"
}

variable "desired_count" {
  description = "How many Fargate tasks to run."
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "Fargate CPU units. 512 = 0.5 vCPU."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate memory in MiB. Must be a legal pairing with task_cpu."
  type        = number
  default     = 1024
}

variable "sse_idle_timeout" {
  description = <<-EOT
    ALB idle timeout, in seconds.

    **This is the one number in this file that is about Arbor specifically.**
    Every screen holds an `/api/live` Server-Sent Events connection open and the
    server may say nothing on it for minutes at a time. The ALB's default idle
    timeout is 60 seconds, which closes exactly those connections — the browser
    reconnects, so nothing looks broken, and the app quietly generates a
    reconnect storm proportional to the number of people using it.
  EOT
  type        = number
  default     = 3600
}

# --- the database -------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class. Graviton (t4g) is cheaper than t3 for the same size."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "GiB. gp3 with storage autoscaling on, so this is a floor."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "arbor"
}

variable "db_username" {
  description = "Master username. The password is generated, never written here."
  type        = string
  default     = "arbor"
}

variable "db_deletion_protection" {
  description = <<-EOT
    Refuse `terraform destroy` on the database.

    On by default: the rest of this environment is disposable and the database
    is not, and the moment they are destroyed by one command is the moment that
    distinction stops being theoretical.
  EOT
  type        = bool
  default     = true
}

variable "db_performance_insights" {
  description = <<-EOT
    Enable RDS Performance Insights.

    Must stay false on the burstable micro and small classes (db.t4g.micro
    included, which is the default here) — AWS rejects the instance outright
    rather than ignoring the flag. Turn it on with a larger class.
  EOT
  type        = bool
  default     = false
}

variable "db_multi_az" {
  description = "Standby in the second AZ. Off by default — it doubles the instance cost."
  type        = bool
  default     = false
}

# --- ingress ------------------------------------------------------------------

variable "certificate_arn" {
  description = <<-EOT
    ACM certificate for HTTPS. When empty the ALB listens on port 80 only, which
    is enough to prove the deployment works and is not a thing to put a session
    cookie through — see the note in alb.tf.
  EOT
  type        = string
  default     = ""
}

variable "allowed_ingress_cidrs" {
  description = "Who may reach the load balancer. Narrow this before there is real data behind it."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
