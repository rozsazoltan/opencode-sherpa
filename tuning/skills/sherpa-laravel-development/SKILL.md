---
name: sherpa-laravel-development
description: Make small Laravel changes that follow the installed framework version and the application's existing patterns.
---

# Laravel development

1. Read `composer.json`, lockfile, Laravel version constraints, relevant routes, controllers, models, policies, migrations, and tests.
2. Follow local conventions for dependency injection, validation, authorization, transactions, and response shapes. Keep authorization checks server-side.
3. Use existing framework features and application services. Avoid new dependencies or broad model changes for a narrow task.
4. Treat migrations as durable schema changes. Check rollback expectations and existing data before changing constraints or column meaning.
5. Add focused tests using the test framework already configured. Use Pest only when the project installs and uses it.
6. Check configured Composer scripts and application test commands before running them. Do not assume Artisan features or packages absent from the project.
7. Summarize behavior changes, relevant checks, and any migration or compatibility concern.
