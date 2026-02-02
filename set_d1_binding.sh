#!/bin/bash

# Cloudflare Account ID
ACCOUNT_ID="a24c09e4fd6d38c9009688e87faac94b"
PROJECT_NAME="yasufumi-yamazaki-tax-accounting-office02"
D1_DATABASE_ID="5cabb78a-ece6-4fcd-bdeb-a72c32708fa2"

# Get current deployment settings
echo "Fetching current project settings..."
curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" | jq '.result.deployment_configs'

