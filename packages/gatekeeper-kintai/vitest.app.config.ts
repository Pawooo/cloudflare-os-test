import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // `app/**` rather than `app/*`: the dictionary, the provider and the toggle live in
    // `app/i18n/`, and a glob that only reached the top level would have left their tests silently
    // uncollected — a green run that proves nothing about the module every screen reads its words
    // from.
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
