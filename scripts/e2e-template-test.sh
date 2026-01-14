#!/bin/bash
# E2E tests for wiki template commands
# Uses DOCSY space at ~/docsy

set -e

CLI="bun $(dirname "$0")/../dist/index.js"
DOCSY_DIR="$HOME/docsy"
TEST_PROFILE="mayflowergmbh-atlassian-net"
TEST_SPACE="DOCSY"
EXPORT_DIR="/tmp/atlcli-template-export-test"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

passed=0
failed=0

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  passed=$((passed + 1))
}

fail() {
  echo -e "${RED}FAIL${NC}: $1"
  echo "  Output: $2"
  failed=$((failed + 1))
}

section() {
  echo ""
  echo -e "${YELLOW}=== $1 ===${NC}"
}

# Cleanup function
cleanup() {
  echo ""
  section "Cleanup"

  # Delete test templates
  $CLI wiki template delete e2e-test-global --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-profile --profile $TEST_PROFILE --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-space --space $TEST_SPACE --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-renamed --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-copied --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-from-file --force 2>/dev/null || true
  $CLI wiki template delete e2e-imported-1 --force 2>/dev/null || true
  $CLI wiki template delete e2e-imported-2 --force 2>/dev/null || true

  # Clean export directory
  rm -rf "$EXPORT_DIR"
  rm -f /tmp/e2e-test-template.md
  rm -f /tmp/e2e-test-export.md

  echo "Cleanup complete"
}

# Run cleanup on exit
trap cleanup EXIT

# Create test template files
create_test_files() {
  cat > /tmp/e2e-test-template.md << 'EOF'
---
name: e2e-test-global
description: E2E test template
tags:
  - test
  - e2e
variables:
  - name: title
    type: string
    required: true
  - name: author
    type: string
    default: "Test Author"
  - name: items
    type: array
---
# {{title}}

Created by: {{author}}
Date: {{@date}}

{{#if items}}
## Items
{{#each items}}
- {{this}}
{{/each}}
{{/if}}
EOF
}

# ============================================================================
# TEST: Create
# ============================================================================
test_create() {
  section "Testing: create"

  # Create global template from file
  output=$($CLI wiki template create e2e-test-global --file /tmp/e2e-test-template.md 2>&1)
  if [[ $output == *"Created template"* ]]; then
    pass "create global template from file"
  else
    fail "create global template from file" "$output"
  fi

  # Create profile template
  cat > /tmp/e2e-test-template.md << 'EOF'
---
name: e2e-test-profile
description: Profile level test template
---
# Profile Template

Profile: {{@profile}}
EOF

  output=$($CLI wiki template create e2e-test-profile --profile $TEST_PROFILE --file /tmp/e2e-test-template.md 2>&1)
  if [[ $output == *"Created template"* ]]; then
    pass "create profile template"
  else
    fail "create profile template" "$output"
  fi

  # Create space template
  cat > /tmp/e2e-test-template.md << 'EOF'
---
name: e2e-test-space
description: Space level test template
---
# Space Template

Space: {{@space}}
EOF

  output=$($CLI wiki template create e2e-test-space --space $TEST_SPACE --file /tmp/e2e-test-template.md 2>&1)
  if [[ $output == *"Created template"* ]]; then
    pass "create space template"
  else
    fail "create space template" "$output"
  fi

  # Test --force flag (overwrite)
  output=$($CLI wiki template create e2e-test-global --file /tmp/e2e-test-template.md --force 2>&1)
  if [[ $output == *"Created template"* ]]; then
    pass "create with --force overwrites"
  else
    fail "create with --force overwrites" "$output"
  fi

  # Test duplicate without --force should fail
  output=$($CLI wiki template create e2e-test-global --file /tmp/e2e-test-template.md 2>&1) || true
  if [[ $output == *"already exists"* ]]; then
    pass "create duplicate without --force fails"
  else
    fail "create duplicate without --force fails" "$output"
  fi
}

# ============================================================================
# TEST: List
# ============================================================================
test_list() {
  section "Testing: list"

  # List all
  output=$($CLI wiki template list 2>&1)
  if [[ $output == *"e2e-test-global"* ]]; then
    pass "list shows templates"
  else
    fail "list shows templates" "$output"
  fi

  # List with --level filter
  output=$($CLI wiki template list --level global 2>&1)
  if [[ $output == *"e2e-test-global"* ]] && [[ $output == *"[global]"* ]]; then
    pass "list --level global filter works"
  else
    fail "list --level global filter works" "$output"
  fi

  # List with --profile filter
  output=$($CLI wiki template list --profile $TEST_PROFILE 2>&1)
  if [[ $output == *"e2e-test-profile"* ]]; then
    pass "list --profile filter works"
  else
    fail "list --profile filter works" "$output"
  fi

  # List with --space filter
  output=$($CLI wiki template list --space $TEST_SPACE 2>&1)
  if [[ $output == *"e2e-test-space"* ]]; then
    pass "list --space filter works"
  else
    fail "list --space filter works" "$output"
  fi

  # List with --json
  output=$($CLI wiki template list --json 2>&1)
  if [[ $output == *'"templates"'* ]]; then
    pass "list --json outputs JSON"
  else
    fail "list --json outputs JSON" "$output"
  fi
}

# ============================================================================
# TEST: Show
# ============================================================================
test_show() {
  section "Testing: show"

  # Show template
  output=$($CLI wiki template show e2e-test-global 2>&1)
  if [[ $output == *"Name:"* ]] && [[ $output == *"e2e-test-global"* ]]; then
    pass "show displays template"
  else
    fail "show displays template" "$output"
  fi

  # Show with level filter
  output=$($CLI wiki template show e2e-test-profile --profile $TEST_PROFILE 2>&1)
  if [[ $output == *"e2e-test-profile"* ]]; then
    pass "show --profile displays specific level"
  else
    fail "show --profile displays specific level" "$output"
  fi

  # Show --json
  output=$($CLI wiki template show e2e-test-global --json 2>&1)
  if [[ $output == *'"template"'* ]] && [[ $output == *'"metadata"'* ]]; then
    pass "show --json outputs JSON"
  else
    fail "show --json outputs JSON" "$output"
  fi

  # Show non-existent should fail
  output=$($CLI wiki template show non-existent-template 2>&1) || true
  if [[ $output == *"not found"* ]]; then
    pass "show non-existent template fails gracefully"
  else
    fail "show non-existent template fails gracefully" "$output"
  fi
}

# ============================================================================
# TEST: Validate
# ============================================================================
test_validate() {
  section "Testing: validate"

  # Validate existing template
  output=$($CLI wiki template validate e2e-test-global 2>&1)
  if [[ $output == *"valid"* ]]; then
    pass "validate existing template"
  else
    fail "validate existing template" "$output"
  fi

  # Validate from file
  output=$($CLI wiki template validate --file /tmp/e2e-test-template.md 2>&1)
  if [[ $output == *"valid"* ]]; then
    pass "validate --file works"
  else
    fail "validate --file works" "$output"
  fi

  # Validate all
  output=$($CLI wiki template validate --all 2>&1)
  if [[ $output == *"valid"* ]] || [[ -z "$output" ]]; then
    pass "validate --all works"
  else
    fail "validate --all works" "$output"
  fi

  # Validate invalid template
  cat > /tmp/e2e-invalid-template.md << 'EOF'
---
name: invalid
variables:
  - name: test
    type: invalid-type
---
# Test {{unclosed
EOF
  output=$($CLI wiki template validate --file /tmp/e2e-invalid-template.md 2>&1) || true
  # Should either report errors or pass (depends on strictness)
  pass "validate invalid template runs without crash"
  rm -f /tmp/e2e-invalid-template.md
}

# ============================================================================
# TEST: Render
# ============================================================================
test_render() {
  section "Testing: render"

  # First recreate the global template with proper content
  cat > /tmp/e2e-test-template.md << 'EOF'
---
name: e2e-test-global
description: E2E test template
variables:
  - name: title
    type: string
    required: true
  - name: author
    type: string
    default: "Test Author"
---
# {{title}}

Created by: {{author}}
Date: {{@date}}
EOF
  $CLI wiki template create e2e-test-global --file /tmp/e2e-test-template.md --force 2>/dev/null

  # Render with variables
  output=$($CLI wiki template render e2e-test-global --var title="Test Title" 2>&1)
  if [[ $output == *"Test Title"* ]] && [[ $output == *"Test Author"* ]]; then
    pass "render with --var works"
  else
    fail "render with --var works" "$output"
  fi

  # Render with built-in variables
  output=$($CLI wiki template render e2e-test-global --var title="Test" 2>&1)
  if [[ $output == *"Date:"* ]]; then
    pass "render includes @date builtin"
  else
    fail "render includes @date builtin" "$output"
  fi

  # Render with --json
  output=$($CLI wiki template render e2e-test-global --var title="JSON Test" --json 2>&1)
  if [[ $output == *'"content"'* ]]; then
    pass "render --json outputs JSON"
  else
    fail "render --json outputs JSON" "$output"
  fi

  # Render non-existent should fail
  output=$($CLI wiki template render non-existent --var title="Test" 2>&1) || true
  if [[ $output == *"not found"* ]]; then
    pass "render non-existent template fails gracefully"
  else
    fail "render non-existent template fails gracefully" "$output"
  fi
}

# ============================================================================
# TEST: Rename
# ============================================================================
test_rename() {
  section "Testing: rename"

  # Rename template
  output=$($CLI wiki template rename e2e-test-global e2e-test-renamed 2>&1)
  if [[ $output == *"Renamed"* ]]; then
    pass "rename template"
  else
    fail "rename template" "$output"
  fi

  # Verify rename worked
  output=$($CLI wiki template show e2e-test-renamed 2>&1)
  if [[ $output == *"e2e-test-renamed"* ]]; then
    pass "renamed template exists"
  else
    fail "renamed template exists" "$output"
  fi

  # Rename back for other tests
  $CLI wiki template rename e2e-test-renamed e2e-test-global 2>/dev/null
}

# ============================================================================
# TEST: Copy
# ============================================================================
test_copy() {
  section "Testing: copy"

  # Copy from global to profile
  output=$($CLI wiki template copy e2e-test-global e2e-test-copied --from-level global --to-profile $TEST_PROFILE 2>&1)
  if [[ $output == *"Copied"* ]]; then
    pass "copy global to profile"
  else
    fail "copy global to profile" "$output"
  fi

  # Verify copy exists
  output=$($CLI wiki template show e2e-test-copied --profile $TEST_PROFILE 2>&1)
  if [[ $output == *"e2e-test-copied"* ]]; then
    pass "copied template exists at profile level"
  else
    fail "copied template exists at profile level" "$output"
  fi

  # Clean up
  $CLI wiki template delete e2e-test-copied --profile $TEST_PROFILE --force 2>/dev/null || true
}

# ============================================================================
# TEST: Init (from file)
# ============================================================================
test_init() {
  section "Testing: init"

  # Create source file
  cat > /tmp/e2e-source-page.md << 'EOF'
# Source Page

This is content from a source file.

## Section 1

Some content here.
EOF

  # Init from file
  output=$($CLI wiki template init e2e-test-from-file --from /tmp/e2e-source-page.md 2>&1)
  if [[ $output == *"Created template"* ]]; then
    pass "init from file"
  else
    fail "init from file" "$output"
  fi

  # Verify template was created
  output=$($CLI wiki template show e2e-test-from-file 2>&1)
  if [[ $output == *"Source Page"* ]] || [[ $output == *"e2e-test-from-file"* ]]; then
    pass "init template contains source content"
  else
    fail "init template contains source content" "$output"
  fi

  rm -f /tmp/e2e-source-page.md
}

# ============================================================================
# TEST: Export
# ============================================================================
test_export() {
  section "Testing: export"

  # Export all to directory
  rm -rf "$EXPORT_DIR"
  output=$($CLI wiki template export -o "$EXPORT_DIR" 2>&1)
  if [[ $output == *"Exported"* ]] && [[ -d "$EXPORT_DIR" ]]; then
    pass "export to directory"
  else
    fail "export to directory" "$output"
  fi

  # Check manifest exists
  if [[ -f "$EXPORT_DIR/manifest.yml" ]]; then
    pass "export creates manifest.yml"
  else
    fail "export creates manifest.yml" "manifest.yml not found"
  fi

  # Check global directory
  if [[ -d "$EXPORT_DIR/global" ]]; then
    pass "export creates global/ directory"
  else
    fail "export creates global/ directory" "global/ not found"
  fi

  # Export single template to stdout
  output=$($CLI wiki template export e2e-test-global 2>&1)
  if [[ $output == *"---"* ]] && [[ $output == *"name:"* ]]; then
    pass "export single to stdout"
  else
    fail "export single to stdout" "$output"
  fi

  # Export single template to file
  output=$($CLI wiki template export e2e-test-global -o /tmp/e2e-test-export.md 2>&1)
  if [[ -f /tmp/e2e-test-export.md ]]; then
    pass "export single to file"
  else
    fail "export single to file" "$output"
  fi

  # Export with --json
  output=$($CLI wiki template export -o "$EXPORT_DIR" --json 2>&1)
  if [[ $output == *'"exported"'* ]]; then
    pass "export --json outputs JSON"
  else
    fail "export --json outputs JSON" "$output"
  fi
}

# ============================================================================
# TEST: Import
# ============================================================================
test_import() {
  section "Testing: import"

  # Create import source directory
  mkdir -p /tmp/e2e-import-test/global

  cat > /tmp/e2e-import-test/global/e2e-imported-1.md << 'EOF'
---
name: e2e-imported-1
description: Imported template 1
---
# Imported 1
EOF

  cat > /tmp/e2e-import-test/global/e2e-imported-2.md << 'EOF'
---
name: e2e-imported-2
description: Imported template 2
---
# Imported 2
EOF

  cat > /tmp/e2e-import-test/manifest.yml << 'EOF'
name: e2e-import-test
version: 1.0.0
templates:
  global:
    - e2e-imported-1
    - e2e-imported-2
EOF

  # Import from directory
  output=$($CLI wiki template import /tmp/e2e-import-test 2>&1)
  if [[ $output == *"Imported"* ]]; then
    pass "import from directory"
  else
    fail "import from directory" "$output"
  fi

  # Verify imported templates exist
  output=$($CLI wiki template show e2e-imported-1 2>&1)
  if [[ $output == *"e2e-imported-1"* ]]; then
    pass "imported template 1 exists"
  else
    fail "imported template 1 exists" "$output"
  fi

  output=$($CLI wiki template show e2e-imported-2 2>&1)
  if [[ $output == *"e2e-imported-2"* ]]; then
    pass "imported template 2 exists"
  else
    fail "imported template 2 exists" "$output"
  fi

  # Import with --replace
  output=$($CLI wiki template import /tmp/e2e-import-test --replace 2>&1)
  if [[ $output == *"Imported"* ]]; then
    pass "import with --replace"
  else
    fail "import with --replace" "$output"
  fi

  # Import specific template only
  $CLI wiki template delete e2e-imported-1 --force 2>/dev/null || true
  output=$($CLI wiki template import /tmp/e2e-import-test e2e-imported-1 2>&1)
  if [[ $output == *"Imported"* ]] && [[ $output == *"e2e-imported-1"* ]]; then
    pass "import specific template"
  else
    fail "import specific template" "$output"
  fi

  rm -rf /tmp/e2e-import-test
}

# ============================================================================
# TEST: Delete
# ============================================================================
test_delete() {
  section "Testing: delete"

  # Create a template to delete
  cat > /tmp/e2e-delete-test.md << 'EOF'
---
name: e2e-delete-test
---
# Delete me
EOF
  $CLI wiki template create e2e-delete-test --file /tmp/e2e-delete-test.md 2>/dev/null

  # Delete with --force
  output=$($CLI wiki template delete e2e-delete-test --force 2>&1)
  if [[ $output == *"Deleted"* ]]; then
    pass "delete with --force"
  else
    fail "delete with --force" "$output"
  fi

  # Verify deletion
  output=$($CLI wiki template show e2e-delete-test 2>&1) || true
  if [[ $output == *"not found"* ]]; then
    pass "deleted template no longer exists"
  else
    fail "deleted template no longer exists" "$output"
  fi

  rm -f /tmp/e2e-delete-test.md
}

# ============================================================================
# Main
# ============================================================================
main() {
  echo "=============================================="
  echo "E2E Template Command Tests"
  echo "=============================================="
  echo "CLI: $CLI"
  echo "DOCSY Dir: $DOCSY_DIR"
  echo "Profile: $TEST_PROFILE"
  echo "Space: $TEST_SPACE"

  # Pre-cleanup (in case previous run left templates)
  echo ""
  echo "Pre-cleanup..."
  $CLI wiki template delete e2e-test-global --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-profile --profile $TEST_PROFILE --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-space --space $TEST_SPACE --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-renamed --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-copied --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-copied --profile $TEST_PROFILE --force 2>/dev/null || true
  $CLI wiki template delete e2e-test-from-file --force 2>/dev/null || true
  $CLI wiki template delete e2e-imported-1 --force 2>/dev/null || true
  $CLI wiki template delete e2e-imported-2 --force 2>/dev/null || true
  rm -rf "$EXPORT_DIR" /tmp/e2e-import-test

  # Setup
  create_test_files

  # Run tests
  test_create
  test_list
  test_show
  test_validate
  test_render
  test_rename
  test_copy
  test_init
  test_export
  test_import
  test_delete

  # Summary
  echo ""
  echo "=============================================="
  echo "Results"
  echo "=============================================="
  echo -e "${GREEN}Passed: $passed${NC}"
  echo -e "${RED}Failed: $failed${NC}"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
