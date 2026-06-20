import type { UIStrings } from "../types";

export default {
  nav: {
    home: "Home",
    posts: "Posts",
    tags: "Tags",
    about: "About",
    archives: "Archives",
    search: "Search",
  },
  post: {
    publishedAt: "Published at",
    updatedAt: "Updated",
    sharePostIntro: "Share this post:",
    sharePostOn: "Share this post on {{platform}}",
    sharePostViaEmail: "Share this post via email",
    tagLabel: "Tags",
    backToTop: "Back to top",
    goBack: "Go back",
    editPage: "Edit page",
    previousPost: "Previous Post",
    nextPost: "Next Post",
  },
  pagination: {
    prev: "Prev",
    next: "Next",
    page: "Page",
    pageNumber: "page {{page}}",
    navigation: "Pagination navigation",
  },
  language: {
    zhCn: "Chinese",
    en: "English",
  },
  social: {
    emailToSite: "Send an email to {{siteTitle}}",
    siteOnPlatform: "{{siteTitle}} on {{platform}}",
  },
  code: {
    copy: "Copy",
    copied: "Copied",
  },
  lightbox: {
    zoomImage: "Zoom image",
    zoomImageWithAlt: "Zoom image: {{alt}}",
    imagePreview: "Image preview",
    imagePreviewWithAlt: "Image preview: {{alt}}",
    closeImagePreview: "Close image preview",
  },
  home: {
    socialLinks: "Social Links",
    featured: "Featured",
    recentPosts: "Recent Posts",
    allPosts: "All Posts",
    heroTitle: "bhwa233 Blog",
    intro:
      "A bilingual engineering blog about development, deployment, tooling, and long-term technical notes.",
    introCtaPrefix: "Read the blog posts or check",
    introCtaLabel: "README",
    introCtaSuffix: "for more info.",
  },
  footer: {
    copyright: "Copyright",
    allRightsReserved: "All rights reserved.",
  },
  pages: {
    tagTitle: "Tag",
    tagDesc: "All the articles with the tag",
    tagTitleWithName: "Tag: {{tagName}}",
    tagDescWithName: 'All the articles with the tag "{{tagName}}".',

    tagsTitle: "Tags",
    tagsDesc: "All the tags used in posts.",

    postsTitle: "Posts",
    postsDesc: "All the articles I've posted.",

    archivesTitle: "Archives",
    archivesDesc: "All the articles I've archived.",

    searchTitle: "Search",
    searchDesc: "Search any article ...",
  },
  a11y: {
    skipToContent: "Skip to content",
    rssFeed: "RSS Feed",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    toggleTheme: "Toggle theme",
    lightTheme: "Light theme",
    darkTheme: "Dark theme",
    languageSwitcher: "Switch language",
    searchPlaceholder: "Search posts...",
    noResults: "No results found",
    goToPreviousPage: "Go to previous page",
    goToNextPage: "Go to next page",
  },
  notFound: {
    title: "404 Not Found",
    message: "Page Not Found",
    goHome: "Go back home",
  },
  search: {
    devModeWarningTitle: "DEV mode warning!",
    devModeWarningText:
      "You need to build the project at least once to see search results during development.",
    buildCommandLabel: "Build command",
    pagefind: {
      language: "en",
      placeholder: "Search",
      clear_search: "Clear",
      load_more: "Load more results",
      search_label: "Search this site",
      filters_label: "Filters",
      zero_results: "No results for [SEARCH_TERM]",
      many_results: "[COUNT] results for [SEARCH_TERM]",
      one_result: "[COUNT] result for [SEARCH_TERM]",
      alt_search:
        "No results for [SEARCH_TERM]. Showing results for [DIFFERENT_TERM] instead",
      search_suggestion:
        "No results for [SEARCH_TERM]. Try one of the following searches:",
      searching: "Searching for [SEARCH_TERM]...",
      total_results: "[COUNT] total results",
      total_result: "[COUNT] total result",
      total_zero_results: "No results",
      loading: "Loading",
    },
  },
} satisfies UIStrings;
