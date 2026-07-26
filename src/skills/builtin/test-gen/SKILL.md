---
name: test-gen
description: Generate test cases for existing code
trigger: /test-gen
tools:
  - read_file
  - write_file
  - glob
priority: 50
---

# Test Generation Skill

## Overview

Generate test cases for existing functions and modules.

## Usage

Trigger: `/test-gen [path]` or `/test-gen [function]`

## Test Generation Strategy

1. **Unit Tests**
   - Function input/output tests
   - Edge case coverage
   - Error handling tests

2. **Integration Tests**
   - Module interaction tests
   - API endpoint tests
   - Database operation tests

3. **Test Patterns**
   - Arrange-Act-Assert
   - Given-When-Then
   - Mock/Stub usage

4. **Coverage Goals**
   - Statement coverage
   - Branch coverage
   - Function coverage

## Output Format

- Test file path
- Test cases generated
- Coverage estimate
- Recommended assertions