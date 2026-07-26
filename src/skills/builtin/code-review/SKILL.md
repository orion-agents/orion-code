---
name: code-review
description: Review code for quality, bugs, and best practices
trigger: /review
tools:
  - read_file
  - glob
  - grep
priority: 60
---

# Code Review Skill

## Overview

Perform comprehensive code review focusing on code quality, potential bugs, and best practices.

## Usage

Trigger: `/review [path]` or `/review all`

## Review Checklist

1. **Code Quality**
   - Naming conventions
   - Code organization
   - Documentation/comments
   - Error handling

2. **Potential Bugs**
   - Null/undefined handling
   - Edge cases
   - Race conditions
   - Memory leaks

3. **Best Practices**
   - TypeScript/JavaScript conventions
   - Security patterns
   - Performance considerations
   - Test coverage

4. **Architecture**
   - Module boundaries
   - Dependency injection
   - Separation of concerns

## Output Format

- Summary of findings
- Specific recommendations
- Priority level (Critical/High/Medium/Low)