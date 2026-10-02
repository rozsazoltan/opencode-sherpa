export type ProjectStack = "php" | "js" | "rust";

export const PROJECT_DETECTION_STACK_ORDER: readonly ProjectStack[] = ["js", "php", "rust"];

export const JS_DEPENDENCY_FEATURES: Readonly<Record<string, string>> = {
  "@angular/core": "angular",
  "@pinia/nuxt": "pinia",
  "@unocss/vite": "unocss",
  gsap: "gsap",
  next: "next",
  nuxt: "nuxt",
  pinia: "pinia",
  react: "react",
  "react-dom": "react",
  tailwindcss: "tailwindcss",
  typescript: "typescript",
  turbo: "turbo",
  vite: "vite",
  vitepress: "vitepress",
  vitest: "vitest",
  unocss: "unocss",
  vue: "vue",
};

export const PHP_DEPENDENCY_FEATURES: Readonly<Record<string, string>> = {
  "laravel/fortify": "fortify",
  "laravel/framework": "laravel",
  "laravel/wayfinder": "wayfinder",
  "pestphp/pest": "pest",
  "phpunit/phpunit": "phpunit",
  "symfony/framework-bundle": "symfony",
};

export const RUST_DEPENDENCY_FEATURES: Readonly<Record<string, string>> = {
  actix: "actix",
  "actix-web": "actix-web",
  anyhow: "anyhow",
  axum: "axum",
  serde: "serde",
  tauri: "tauri",
  tokio: "tokio",
};
