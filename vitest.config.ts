import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

export default defineConfig({
  define: {
    __DEV__: true,
    __PROD__: false,
  },
  test: {
    environment: "node",
    alias: Object.fromEntries(
      fs
        .readdirSync(path.resolve(__dirname, "src"), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => [
          dirent.name,
          path.resolve(__dirname, `./src/${dirent.name}`),
        ]),
    ),
  },
});
