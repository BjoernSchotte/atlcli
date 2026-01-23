# CI/CD Documentation

Publish documentation from CI/CD pipelines.

## Prerequisites

- Atlassian API token stored as CI/CD secret
- atlcli installed in CI environment
- **Confluence permission**: Edit Pages

## Use Case

Automatically publish documentation to Confluence when:

- Code is merged to main
- Release is tagged
- Documentation files change

## GitHub Actions

### On Push to Main

```yaml
name: Publish Docs

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: curl -fsSL https://atlcli.sh/install.sh | bash

      - name: Push to Confluence
        env:
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: ~/.atlcli/bin/atlcli wiki docs push ./docs
```

### On Release

```yaml
name: Release Docs

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: curl -fsSL https://atlcli.sh/install.sh | bash

      - name: Update version in docs
        run: |
          sed -i "s/VERSION_PLACEHOLDER/${{ github.ref_name }}/g" docs/index.md

      - name: Push to Confluence
        env:
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: ~/.atlcli/bin/atlcli wiki docs push ./docs
```

## GitLab CI

```yaml
stages:
  - publish

publish-docs:
  stage: publish
  only:
    refs:
      - main
    changes:
      - docs/**
  script:
    - curl -fsSL https://atlcli.sh/install.sh | bash
    - ~/.atlcli/bin/atlcli wiki docs push ./docs
  variables:
    ATLCLI_BASE_URL: $ATLASSIAN_URL
    ATLCLI_EMAIL: $ATLASSIAN_EMAIL
    ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

## Jenkins

```groovy
pipeline {
    agent any

    environment {
        ATLCLI_BASE_URL = credentials('atlassian-url')
        ATLCLI_EMAIL = credentials('atlassian-email')
        ATLCLI_API_TOKEN = credentials('atlassian-token')
    }

    stages {
        stage('Install atlcli') {
            steps {
                sh 'curl -fsSL https://atlcli.sh/install.sh | bash'
            }
        }
        stage('Publish Docs') {
            when {
                changeset 'docs/**'
            }
            steps {
                sh '~/.atlcli/bin/atlcli wiki docs push ./docs'
            }
        }
    }
}
```

## Best Practices

1. **Use secrets** - Never commit credentials
2. **Path filtering** - Only run when docs change
3. **Dry run first** - Test with `--dry-run` flag
4. **Version tagging** - Include version in doc pages
5. **Failure handling** - Don't block releases on doc failures

## Related Topics

- [Authentication](../authentication.md) - Environment variable authentication
- [Confluence Sync](../confluence/sync.md) - Full sync documentation
- [Team Docs](team-docs.md) - Manual workflow
