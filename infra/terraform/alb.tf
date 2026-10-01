/**
 * The load balancer, and the two settings that exist because of Server-Sent
 * Events.
 *
 * Arbor's live updates are one long-lived `GET /api/live` per open screen
 * (D-090, D-092). That is the reason the README chose Fargate over Lambda, and
 * it is also the reason two numbers here are not defaults:
 *
 * 1. **`idle_timeout`** — 60 seconds by default, and a stream that says nothing
 *    for 60 seconds is idle by that definition. The browser's `EventSource`
 *    reconnects silently, so the symptom is not an error but a reconnect every
 *    minute from every open tab, which looks like load rather than a bug.
 * 2. **`deregistration_delay`** — the default 300 seconds holds a draining task
 *    alive for five minutes waiting for connections that, here, are *designed*
 *    never to close. 30 seconds is long enough to finish a page render and
 *    short enough that a deploy is a deploy.
 */

resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  idle_timeout = var.sse_idle_timeout

  # Off, unlike the database's. Losing the ALB is an outage that a re-apply
  # fixes in minutes; losing the database is unrecoverable, which is why that
  # one is protected and this one is not. Turn it on once a real domain points
  # here and a re-apply would mean a DNS change too.
  enable_deletion_protection = false

  # Drops requests whose headers disagree about their own length rather than
  # forwarding them for the app to interpret — request smuggling starts with
  # two components reading one request differently.
  desync_mitigation_mode     = "strictest"
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # awsvpc networking: targets are task IPs, not instances

  deregistration_delay = 30

  health_check {
    enabled  = true
    path     = "/api/health"
    protocol = "HTTP"
    matcher  = "200"
    # The route asks Postgres `SELECT 1`, so this is not a liveness ping — an
    # interval under the query's worst case would fail a task for being busy.
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- listeners ----------------------------------------------------------------
#
# With a certificate: 80 redirects to 443, and 443 serves. Without one: 80
# serves directly, which is enough to prove a deployment works and is not
# somewhere to put a session cookie — `arbor_session` is a bearer token in a
# cookie (`apps/web/src/server/auth.ts`), and over plain HTTP it is readable by
# anything on the path. Supply `certificate_arn` before there is a real user.

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.certificate_arn == "" ? "forward" : "redirect"

    target_group_arn = var.certificate_arn == "" ? aws_lb_target_group.web.arn : null

    dynamic "redirect" {
      for_each = var.certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == "" ? 0 : 1

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 floor, and the forward-secrecy-only cipher list.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
