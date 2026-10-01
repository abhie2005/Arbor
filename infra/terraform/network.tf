/**
 * Two tiers: public subnets hold the load balancer and the NAT, private subnets
 * hold the tasks and the database.
 *
 * The tasks are private and reach the internet through NAT, rather than sitting
 * in public subnets with public IPs. The cheaper arrangement saves the NAT
 * hourly charge and gives every task a routable address, which for a service
 * that only ever needs to be reached *through* the ALB is a way to be reachable
 * by accident.
 *
 * One NAT gateway, not one per AZ. It is a single point of failure for outbound
 * traffic — image pulls and nothing else at present, since the app talks only
 * to Postgres inside the VPC — and per-AZ NAT is the first thing to change if
 * outbound traffic ever becomes load-bearing.
 */

locals {
  name = "arbor-${var.environment}"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count = length(var.azs)

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${var.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count = length(var.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = var.azs[count.index]
  # Offset so public and private never overlap as the AZ count changes.
  cidr_block = cidrsubnet(var.vpc_cidr, 4, count.index + length(var.azs))

  tags = { Name = "${local.name}-private-${var.azs[count.index]}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = local.name }

  # A NAT in a public subnet with no route to the gateway is a NAT that silently
  # routes nowhere, so the dependency is declared rather than inferred.
  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- security groups ----------------------------------------------------------
#
# Three groups, and the rules between them reference each other by id rather
# than by CIDR. A CIDR rule says "anything in this subnet", which stays true
# after something else is put in that subnet; a group reference says "the load
# balancer", which is what is actually meant.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ingress to the load balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count = length(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP"
  cidr_ipv4         = var.allowed_ingress_cidrs[count.index]
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count = var.certificate_arn == "" ? 0 : length(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  cidr_ipv4         = var.allowed_ingress_cidrs[count.index]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "To the tasks"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "Fargate tasks: ingress from the ALB only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "The app port, from the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "Image pulls, logs, Secrets Manager, and Postgres"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "database" {
  name        = "${local.name}-db"
  description = "Postgres: reachable from the tasks and nothing else"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "Postgres from the app and the migration task"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# No egress rule on the database group, which means none: Postgres answers on a
# connection the client opened and never starts one of its own.
