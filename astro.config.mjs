// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://atlcli.sh',
  integrations: [
    starlight({
      title: 'atlcli',
      description: 'Extensible CLI for Atlassian products',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/BjoernSchotte/atlcli',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/BjoernSchotte/atlcli/edit/main/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Getting Started', link: '/getting-started/' },
        {
          label: 'Confluence',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/confluence/' },
            { label: 'Sync', link: '/confluence/sync/' },
            { label: 'Pages', link: '/confluence/pages/' },
            { label: 'Spaces', link: '/confluence/spaces/' },
            { label: 'Folders', link: '/confluence/folders/' },
            { label: 'Search', link: '/confluence/search/' },
            { label: 'Comments', link: '/confluence/comments/' },
            { label: 'Labels', link: '/confluence/labels/' },
            { label: 'History', link: '/confluence/history/' },
            { label: 'Templates', link: '/confluence/templates/' },
            { label: 'Macros', link: '/confluence/macros/' },
            { label: 'Attachments', link: '/confluence/attachments/' },
            { label: 'Webhooks', link: '/confluence/webhooks/' },
            { label: 'Validation', link: '/confluence/validation/' },
            { label: 'Audit', link: '/confluence/audit/' },
            { label: 'Export', link: '/confluence/export/' },
            { label: 'Ignore Patterns', link: '/confluence/ignore/' },
            { label: 'File Format', link: '/confluence/file-format/' },
            { label: 'Storage Format', link: '/confluence/storage/' },
          ],
        },
        {
          label: 'Jira',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/jira/' },
            { label: 'Issues', link: '/jira/issues/' },
            { label: 'Search', link: '/jira/search/' },
            { label: 'Projects', link: '/jira/projects/' },
            { label: 'Boards & Sprints', link: '/jira/boards-sprints/' },
            { label: 'Time Tracking', link: '/jira/time-tracking/' },
            { label: 'Epics', link: '/jira/epics/' },
            { label: 'Subtasks', link: '/jira/subtasks/' },
            { label: 'Attachments', link: '/jira/attachments/' },
            { label: 'Analytics', link: '/jira/analytics/' },
            { label: 'Bulk Operations', link: '/jira/bulk-operations/' },
            { label: 'Filters', link: '/jira/filters/' },
            { label: 'Templates', link: '/jira/templates/' },
            { label: 'Import/Export', link: '/jira/import-export/' },
            { label: 'Webhooks', link: '/jira/webhooks/' },
            { label: 'Fields', link: '/jira/fields/' },
          ],
        },
        {
          label: 'Recipes',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/recipes/' },
            { label: 'Team Docs Sync', link: '/recipes/team-docs/' },
            { label: 'Sprint Reporting', link: '/recipes/sprint-reporting/' },
            { label: 'CI/CD Docs', link: '/recipes/ci-cd-docs/' },
            { label: 'Issue Triage', link: '/recipes/issue-triage/' },
          ],
        },
        {
          label: 'Plugins',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/plugins/' },
            { label: 'Using Plugins', link: '/plugins/using-plugins/' },
            { label: 'Creating Plugins', link: '/plugins/creating-plugins/' },
            { label: 'Git Plugin', link: '/plugins/plugin-git/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'CLI Commands', link: '/reference/cli-commands/' },
            { label: 'Authentication', link: '/authentication/' },
            { label: 'Configuration', link: '/configuration/' },
            { label: 'Doctor', link: '/reference/doctor/' },
            { label: 'Shell Completion', link: '/reference/shell-completions/' },
            { label: 'Updating', link: '/reference/updating/' },
            { label: 'Logging', link: '/reference/logging/' },
            { label: 'Environment', link: '/reference/environment/' },
            { label: 'Troubleshooting', link: '/reference/troubleshooting/' },
          ],
        },
        { label: 'Contributing', link: '/contributing/' },
      ],
      // i18n infrastructure (English only for now)
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        // de: { label: 'Deutsch', lang: 'de' },  // Future
      },
    }),
  ],
});
