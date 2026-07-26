---
name: security-check
description: Scan code for security vulnerabilities
trigger: /security
tools:
  - read_file
  - glob
  - grep
priority: 70
---

# Security Check Skill

## Overview

Identify potential security vulnerabilities in code.

## Usage

Trigger: `/security [path]`

## Security Patterns to Check

1. **Injection Vulnerabilities**
   - SQL injection
   - XSS (Cross-Site Scripting)
   - Command injection
   - Path traversal

2. **Authentication/Authorization**
   - Hardcoded credentials
   - Weak password handling
   - Session management issues

3. **Data Protection**
   - Sensitive data exposure
   - Insecure storage
   - Missing encryption

4. **Dependencies**
   - Known vulnerable packages
   - Outdated dependencies

5. **OWASP Top 10**
   - Broken access control
   - Security misconfiguration
   - Using components with known vulnerabilities

## Output Format

- Vulnerability type
- Location in code
- Severity (Critical/High/Medium/Low)
- Remediation steps