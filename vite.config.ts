import { defineConfig } from "vite";
import fs from "fs";
import path from "path";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [],

  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === "development"),
    __PROD__: JSON.stringify(process.env.NODE_ENV === "production"),
  },

  resolve: {
    // alias for every top level directories in src
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

  build: {
    lib: {
      entry: path.resolve(__dirname, "src/world.ts"),
      name: "OECS",
      fileName: (format) => `OECS.${format}.js`,
    },
  },
}));
