import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Jinn Project Specification',
  tagline: 'Multi-Agent Blockchain Automation System',
  favicon: 'img/favicon.png',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://jinn-project.github.io',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'jinn-project', // Usually your GitHub org/user name.
  projectName: 'jinn-cli-agents', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  scripts: [
    {
      src: 'https://umami-production-ae2b.up.railway.app/script.js',
      defer: true,
      'data-website-id': 'deeb793f-bbd0-44e0-b628-bb7978a24626',
    },
  ],

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../../docs/site',
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/jinn-project/jinn-cli-agents/tree/main/docs/site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: ['@docusaurus/theme-mermaid'],
  
  markdown: {
    mermaid: true,
  },

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    navbar: {
      title: 'Jinn Project',
      logo: {
        alt: 'Jinn Project Logo',
        src: 'img/logo.png',
      },
      hideOnScroll: false,
      items: [
        {
          href: 'https://jinn.network',
          label: 'Website',
          position: 'right',
        },
        {
          href: 'https://explorer.jinn.network',
          label: 'Explorer',
          position: 'right',
        },
        {
          href: 'https://blog.jinn.network',
          label: 'Blog',
          position: 'right',
        },
        {
          href: 'https://github.com/jinn-network',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Copyright © ${new Date().getFullYear()} Jinn Project`,
    },
    prism: {
      theme: prismThemes.dracula,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
