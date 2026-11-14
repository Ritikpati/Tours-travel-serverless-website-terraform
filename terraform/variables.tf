variable "region" {
  default = "us-east-1"
}
variable "prefix" {
  description = "Prefix for names that don't have to match the Lambda code"
  default     = "tf"
}
variable "zone_name" {
  default = "215726090298.realhandsonlabs.net"
}
variable "subdomain" {
  default = "tours-tf"
}
variable "upi_id" {
  default = "yourupi@bank"
}
variable "admin_password_hash" {
  description = "SHA-256 of the admin password (default is admin123)"
  default     = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9"
}
variable "seed_packages" {
  description = "Add the sample packages on first apply"
  default     = true
}
