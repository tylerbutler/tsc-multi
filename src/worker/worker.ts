import type ts from "typescript";
import debug from "./debug";
import { createReporter, Reporter } from "../report";
import {
  mergeCustomTransformers,
  trimSuffix,
  isIncrementalCompilation,
} from "../utils";
import { createRewriteImportTransformer } from "../transformers/rewriteImport";
import { createRewriteDtsImportTransformer } from "../transformers/rewriteDtsImport";
import { WorkerOptions } from "./types";
import { dirname, extname, join } from "path";

const JS_EXT = ".js";
const MAP_EXT = ".map";
const JS_MAP_EXT = `${JS_EXT}${MAP_EXT}`;
const DTS_EXT = ".d.ts";
const DTS_MAP_EXT = `${DTS_EXT}${MAP_EXT}`;

type TS = typeof ts;

function loadCompiler(cwd: string, name = "typescript"): TS {
  const path = require.resolve(name, { paths: [cwd, __dirname] });
  return require(path);
}

export class Worker {
  private readonly ts: TS;
  private readonly system: ts.System;
  private readonly reporter: Reporter;

  constructor(private readonly data: WorkerOptions, system?: ts.System) {
    this.ts = loadCompiler(data.cwd, data.compiler);
    this.system = this.createSystem(system || this.ts.sys);
    this.reporter = createReporter({
      cwd: data.cwd,
      system: this.system,
      formatDiagnostics: this.ts.formatDiagnosticsWithColorAndContext,
      output: process.stderr,
      prefix: data.reportPrefix,
    });
  }

  public run(): number {
    if (this.data.transpileOnly) {
      this.transpile();
      return 0;
    }

    const builder = this.createBuilder();

    if (this.data.clean) {
      return builder.clean();
    }

    return builder.build();
  }

  private getJSPath(path: string): string {
    if (!this.data.extname) return path;

    return trimSuffix(path, JS_EXT) + this.data.extname;
  }

  private getDtsPath(path: string): string {
    if (!this.data.dtsExtName) return path;

    return trimSuffix(path, DTS_EXT) + this.data.dtsExtName;
  }

  private getJSMapPath(path: string): string {
    if (!this.data.extname) return path;

    return trimSuffix(path, JS_MAP_EXT) + this.data.extname + MAP_EXT;
  }

  private getDtsMapPath(path: string): string {
    if (!this.data.dtsExtName) return path;

    return trimSuffix(path, DTS_MAP_EXT) + this.data.dtsExtName + MAP_EXT;
  }

  /**
   * Rewrites an output file path based on its extension. If ignoreDts is true, then paths to .d.ts files will not be
   * rewritten. This is used so that .d.ts file paths are only rewritten under specific circumstances.
   */
  private rewritePath(path: string, ignoreDts = false): string {
    if (path.endsWith(JS_EXT)) {
      return this.getJSPath(path);
    }

    if (path.endsWith(JS_MAP_EXT)) {
      return this.getJSMapPath(path);
    }

    if (ignoreDts === false) {
      if (path.endsWith(DTS_EXT)) {
        return this.getDtsPath(path);
      }

      if (path.endsWith(DTS_MAP_EXT)) {
        return this.getDtsMapPath(path);
      }
    }

    return path;
  }

  private rewriteSourceMappingURL(data: string): string {
    return data.replace(/\/\/# sourceMappingURL=(.+)/g, (_, path) => {
      debug(
        `replacing sourceMapUrl path: ${path} ==> ${this.rewritePath(path)}`
      );
      return `//# sourceMappingURL=${this.rewritePath(path)}`;
    });
  }

  private rewriteSourceMap(data: string): string {
    const json = JSON.parse(data);
    debug(
      `rewriting sourcemap: ${json.file} ==> ${this.rewritePath(json.file)}`
    );
    json.file = this.rewritePath(json.file);
    return JSON.stringify(json);
  }

  private createSystem(sys: Readonly<ts.System>): ts.System {
    const getReadPaths = (path: string) => {
      /**
       * When reading paths, we don't want to rewrite the paths to DTS files, so we pass `true` to ignoreDts. If we
       * rewrite dts paths here, we get compilation failures like this:
       *
       * [mjs]: error TS6053: File 'FluidFramework/node_modules/.pnpm/typescript@5.1.6/node_modules/typescript/lib/lib.dom.d.ts' not found.
       *   The file is in the program because:
       *     Library 'lib.dom.d.ts' specified in compilerOptions
       * [mjs]: error TS6053: File 'FluidFramework/node_modules/.pnpm/typescript@5.1.6/node_modules/typescript/lib/lib.dom.iterable.d.ts' not found.
       *   The file is in the program because:
       *     Library 'lib.dom.iterable.d.ts' specified in compilerOptions
       * [mjs]: error TS6053: File 'FluidFramework/node_modules/.pnpm/typescript@5.1.6/node_modules/typescript/lib/lib.es2020.d.ts' not found.
       *   The file is in the program because:
       *     Library 'lib.es2020.d.ts' specified in compilerOptions
       * [mjs]: error TS2318: Cannot find global type 'Array'.
       * [mjs]: error TS2318: Cannot find global type 'Boolean'.
       * [mjs]: error TS2318: Cannot find global type 'CallableFunction'.
       * [mjs]: error TS2318: Cannot find global type 'Function'.
       * [mjs]: error TS2318: Cannot find global type 'IArguments'.
       * [mjs]: error TS2318: Cannot find global type 'NewableFunction'.
       * [mjs]: error TS2318: Cannot find global type 'Number'.
       * [mjs]: error TS2318: Cannot find global type 'Object'.
       * [mjs]: error TS2318: Cannot find global type 'RegExp'.
       * [mjs]: error TS2318: Cannot find global type 'String'.
       * [mjs]: Found 13 errors.
       */
      const paths = [this.rewritePath(path, true)];

      // Source files may be .js files when `allowJs` is enabled. When a .js
      // file with rewritten path doesn't exist, retry again without rewriting
      // the path.
      if (path.endsWith(JS_EXT)) {
        paths.push(path);
      }

      return paths;
    };

    return {
      ...sys,
      fileExists: (inputPath) => {
        return getReadPaths(inputPath).reduce<boolean>(
          (result, path) => result || sys.fileExists(path),
          false
        );
      },
      readFile: (inputPath, encoding) => {
        return (
          getReadPaths(inputPath).reduce<string | undefined | null>(
            (result, path) => result ?? sys.readFile(path, encoding),
            null
          ) ?? undefined
        );
      },
      writeFile: (path, data, writeByteOrderMark) => {
        const newPath = this.rewritePath(path);
        const newData = (() => {
          if (path.endsWith(JS_EXT) || path.endsWith(DTS_EXT)) {
            return this.rewriteSourceMappingURL(data);
          }

          if (path.endsWith(JS_MAP_EXT) || path.endsWith(DTS_MAP_EXT)) {
            return this.rewriteSourceMap(data);
          }

          return data;
        })();

        debug("Write file: %s", newPath);
        sys.writeFile(newPath, newData, writeByteOrderMark);
      },
      deleteFile: (path) => {
        const newPath = this.rewritePath(path);
        debug("Delete file: %s", newPath);
        sys.deleteFile?.(newPath);
      },
    };
  }

  private createBuilder() {
    const buildOptions: ts.BuildOptions = {
      verbose: this.data.verbose,
      dry: this.data.dry,
      force: this.data.force,
    };
    const createProgram = this.ts.createSemanticDiagnosticsBuilderProgram;

    if (this.data.watch) {
      const host = this.ts.createSolutionBuilderWithWatchHost(
        this.system,
        createProgram,
        this.reporter.reportDiagnostic,
        this.reporter.reportSolutionBuilderStatus,
        this.reporter.reportWatchStatus
      );
      this.patchSolutionBuilderHost(host);

      return this.ts.createSolutionBuilderWithWatch(
        host,
        this.data.projects,
        buildOptions
      );
    }

    const host = this.ts.createSolutionBuilderHost(
      this.system,
      createProgram,
      this.reporter.reportDiagnostic,
      this.reporter.reportSolutionBuilderStatus,
      this.reporter.reportErrorSummary
    );
    this.patchSolutionBuilderHost(host);

    return this.ts.createSolutionBuilder(
      host,
      this.data.projects,
      buildOptions
    );
  }

  private patchSolutionBuilderHost<T extends ts.BuilderProgram>(
    host: ts.SolutionBuilderHostBase<T>
  ) {
    const { createProgram, reportDiagnostic } = host;

    debug(`dtsExtName === ${this.data.dtsExtName}`);
    const transformers: ts.CustomTransformers =
      this.data.dtsExtName !== undefined
        ? {
            after: [
              createRewriteImportTransformer({
                extname: this.data.extname || JS_EXT,
                dtsExtName: this.data.dtsExtName || DTS_EXT,
                system: this.system,
                ts: this.ts,
              }),
            ],
            afterDeclarations: [
              createRewriteDtsImportTransformer({
                extname: this.data.extname || JS_EXT,
                dtsExtName: this.data.dtsExtName || DTS_EXT,
                system: this.system,
                ts: this.ts,
              }),
            ],
          }
        : {
            after: [
              createRewriteImportTransformer({
                extname: this.data.extname || JS_EXT,
                dtsExtName: this.data.dtsExtName || DTS_EXT,
                system: this.system,
                ts: this.ts,
              }),
            ],
          };

    const parseConfigFileHost: ts.ParseConfigFileHost = {
      ...this.system,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        reportDiagnostic?.(diagnostic);
      },
    };

    host.getParsedCommandLine = (path: string) => {
      const basePath = trimSuffix(path, extname(path));
      const { options } = this.ts.convertCompilerOptionsFromJson(
        this.data.target,
        dirname(path),
        path
      );

      const config = this.ts.getParsedCommandLineOfConfigFile(
        path,
        options,
        parseConfigFileHost
      );
      if (!config) return;

      // Set separated tsbuildinfo paths to avoid that multiple workers to
      // access the same tsbuildinfo files and potentially read/write corrupted
      // tsbuildinfo files
      if (
        this.data.extname &&
        !config.options.tsBuildInfoFile &&
        isIncrementalCompilation(config.options)
      ) {
        config.options.tsBuildInfoFile = `${basePath}${this.data.extname}.tsbuildinfo`;
      }

      return config;
    };

    host.createProgram = (...args) => {
      const program = createProgram(...args);
      const emit = program.emit;

      program.emit = (
        targetSourceFile,
        writeFile,
        cancellationToken,
        emitOnlyDtsFiles,
        customTransformers
      ) => {
        return emit(
          targetSourceFile,
          writeFile,
          cancellationToken,
          emitOnlyDtsFiles,
          mergeCustomTransformers(customTransformers || {}, transformers)
        );
      };

      return program;
    };
  }

  private transpile() {
    for (const project of this.data.projects) {
      this.transpileProject(project);
    }
  }

  private transpileProject(projectPath: string) {
    const tsConfigPath = this.system.fileExists(projectPath)
      ? projectPath
      : join(projectPath, "tsconfig.json");
    const { options } = this.ts.convertCompilerOptionsFromJson(
      this.data.target,
      projectPath,
      tsConfigPath
    );
    const parseConfigFileHost: ts.ParseConfigFileHost = {
      ...this.system,
      onUnRecoverableConfigFileDiagnostic: this.reporter.reportDiagnostic,
    };

    const config = this.ts.getParsedCommandLineOfConfigFile(
      tsConfigPath,
      options,
      parseConfigFileHost
    );
    if (!config) return;

    // TODO: Merge custom transformers
    const transformers: ts.CustomTransformers = {
      after: [
        createRewriteImportTransformer({
          extname: this.data.extname || JS_EXT,
          dtsExtName: this.data.dtsExtName || DTS_EXT,
          system: this.system,
          ts: this.ts,
        }),
      ],
    };

    for (const inputPath of config.fileNames) {
      // - Ignore if file does not exist
      // - or if file is a declaration file, which will generate an empty file and
      //   throw "Output generation failed" error
      if (!this.system.fileExists(inputPath) || inputPath.endsWith(".d.ts")) {
        continue;
      }

      const content = this.system.readFile(inputPath) || "";
      const [outputPath, sourceMapPath] = this.ts.getOutputFileNames(
        config,
        inputPath,
        false
      );
      const output = this.ts.transpileModule(content, {
        compilerOptions: config.options,
        fileName: inputPath,
        reportDiagnostics: true,
        transformers,
      });

      for (const diag of output.diagnostics ?? []) {
        this.reporter.reportDiagnostic(diag);
      }

      this.system.writeFile(outputPath, output.outputText);

      if (typeof output.sourceMapText === "string") {
        this.system.writeFile(sourceMapPath, output.sourceMapText);
      }
    }
  }
}
