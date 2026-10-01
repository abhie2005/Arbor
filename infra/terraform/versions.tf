/**
 * The AWS path, as the smallest thing that actually runs (D-114).
 *
 * This provisions one environment: a VPC, RDS Postgres, an ECS Fargate service
 * behind an ALB, and the two ECR repositories the Dockerfile's two targets push
 * to. It deliberately does not provision S3, SES, SQS, ElastiCache or Bedrock —
 * the README's table lists those because the design accommodates them, and the
 * project's own rule is that a managed service arrives when a feature needs it,
 * with the local implementation written first. Nothing needs them yet.
 *
 * State is local by default so that `terraform init` works with no prior setup.
 * Before anyone else runs this, move it to S3 with a DynamoDB lock table —
 * local state plus two operators is how an environment gets destroyed by the
 * person who did not have the newest file.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment and fill in once a bucket exists. Keep the lock table.
  #
  # backend "s3" {
  #   bucket         = "arbor-terraform-state"
  #   key            = "env/prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "arbor-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "arbor"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
