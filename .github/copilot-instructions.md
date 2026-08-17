# Project setup checklist

- [x] Clarify Project Requirements
  - Vite + vanilla TypeScript; original three-pane Tri-Cities, Washington punk/metal community site.
- [x] Scaffold the Project
  - Vite vanilla TypeScript structure and npm scripts created.
- [x] Customize the Project
  - Responsive panes, demo chat, event filters, radio placeholder, and live board implemented.
- [x] Install Required Extensions
  - No project-specific extensions required.
- [x] Compile the Project
  - TypeScript and Vite production build verified from a local temporary copy; the mapped drive blocks Node realpath/package operations on Windows.
- [x] Create and Run Task
  - Standard development and production build tasks are available in `.vscode/tasks.json`; equivalent production build validated.
- [x] Launch the Project
  - Responsive site previewed in the integrated browser.
- [x] Ensure Documentation is Complete
  - README and project instructions are current.

## Project conventions

- Keep the visual identity original; do not copy text, branding, or assets from reference sites.
- Use semantic, accessible HTML and responsive CSS.
- Keep the radio controls offline until a streaming source is designed and configured.
- Browser-only community features must not imply secure or persistent server storage.
- Run the public site, admin panel, API, and SQLite database in one Node process on the application VM.
- Treat the separate Nginx VM as a TLS-terminating reverse proxy; restrict the Node port to that proxy's private IP.
