import { resolve, dirname, extname } from "path";
import ts from "typescript";
import { trimSuffix } from "../utils";
import { RewriteImportTransformerOptions } from "./rewriteImport";

const JS_EXT = ".js";
const JSON_EXT = ".json";

function isRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}
export function createRewriteDtsImportTransformer(
  options: RewriteImportTransformerOptions
): ts.TransformerFactory<ts.SourceFile | ts.Bundle> {
  const {
    sys,
    factory,
    isStringLiteral,
    isImportDeclaration,
    isCallExpression,
    SyntaxKind,
    visitNode,
    visitEachChild,
    isIdentifier,
    isExportDeclaration,
  } = options.ts;

  function isDirectory(sourceFile: ts.SourceFile, path: string): boolean {
    const sourcePath = sourceFile.fileName;
    const fullPath = resolve(dirname(sourcePath), path);

    return sys.directoryExists(fullPath);
  }

  function updateModuleSpecifier(
    ctx: ts.TransformationContext,
    sourceFile: ts.SourceFile,
    node: ts.Expression
  ): ts.Expression {
    if (!isStringLiteral(node) || !isRelativePath(node.text)) return node;

    const ext = extname(node.text);
    if (ext === ".cjs") {
      return factory.createStringLiteral(node.text);
    }

    if (isDirectory(sourceFile, node.text)) {
      return factory.createStringLiteral(
        `${node.text}/index${options.extname}`
      );
    }

    if (ext === JSON_EXT && ctx.getCompilerOptions().resolveJsonModule) {
      return node;
    }

    const base = ext === JS_EXT ? trimSuffix(node.text, JS_EXT) : node.text;

    return factory.createStringLiteral(`${base}${options.extname}`);
  }

  return (ctx) => {
    let sourceFile: ts.SourceFile;

    const recentNodes: ts.Node[] = [];

    const visitor: ts.Visitor = (node) => {
      // Add current node to the beginning of the list of recent nodes; keep 3 max.
      if (recentNodes.unshift(node) > 3) {
        recentNodes.pop();
      }

      // if (sourceFile.fileName.includes("testRecursiveDomain")) {
      //   console.log(
      //     `VISITOR [nodeKind: ${node.kind}, parent: ${node.parent?.kind
      //     }, text: ${(node as any)?.text}, pos: ${node.pos}]`
      //   );
      //   console.log(
      //     `RECENT_NODES: ${recentNodes[0]?.kind} ${recentNodes[1]?.kind} ${recentNodes[2]?.kind}`
      //   );
      // }
      // ESM import
      if (isImportDeclaration(node)) {
        return factory.createImportDeclaration(
          node.modifiers,
          node.importClause,
          updateModuleSpecifier(ctx, sourceFile, node.moduleSpecifier),
          node.assertClause
        );
      }

      // ESM export
      if (isExportDeclaration(node)) {
        if (!node.moduleSpecifier) return node;

        return factory.createExportDeclaration(
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          updateModuleSpecifier(ctx, sourceFile, node.moduleSpecifier),
          node.assertClause
        );
      }

      // Extremely britle way to detect dynamic imports that aren't caught by
      //   isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
      //
      // They come up in some cases when we don't do explicit typing in source code and the type declaration files
      // end up looking something like this:
      //
      //  export declare const EncodedSchemaChange: import("@sinclair/typebox").TObject<{
      //    new: import("@sinclair/typebox").TObject<{
      //      version: import("@sinclair/typebox").TLiteral<1>;
      //      nodes: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
      //      ...
      //
      // Tree has several cases, but the fully-defined explicit types are a nightmare to maintain.
      if (recentNodes.length == 3) {
        // if (sourceFile.fileName.includes("testRecursiveDomain")) {
        //   console.log(
        //     `CHECKING: ${isStringLiteral(node)} ${isMappedTypeNode(
        //       recentNodes[1]
        //     )} ${isTemplateLiteralTypeSpan(recentNodes[2])}`
        //   );
        // }
        // NOTE: using isMappedTypeNode and isTemplateLiteralTypeSpan from options.ts was not working, returning false
        // when the versions straight from 'ts' return true.
        if (
          isStringLiteral(node) &&
          // If we hardcode these values (200, 204), which are the ones in TS 5.1.6, things work. In TS 5.0.3, the
          // values are 197 and 201. Compiling tsc-multi with TS 5.0.3 seems to produce build output that ends up with
          // the older values embedded somehow (probably enums being replaced with their underlying primitive value),
          // which makes thing not work when running with TS 5.1.6, where the node kinds will have the new values.
          // The ideal solution uses isTemplateLiteralTypeSpan() and isMappedTypeNode() imported from the Typescript
          // package but it runs into the same problem (I assume the function definitions that end up in the built
          // tsc-multi have the old values hardcoded).
          // Maybe a "deeper patch" of tsc-multi would help here, but things start getting really weird and brittle.
          recentNodes[1].kind == 200 && // SyntaxKind.MappedType
          recentNodes[2].kind == 204 // SyntaxKind.TemplateLiteralTypeSpan
        ) {
          // The current node is the argument to a dynamic import (i.e. `import("../..")`) of a particular kind that is
          // not caught by other conditions in this file. We need to transform the string literal to a valid path
          // with a file name and extension so the ESM build doesn't complain.

          if (sourceFile.fileName.includes("testRecursiveDomain")) {
            console.log(
              `sourceFile: ${sourceFile.fileName}, ${
                node.text
              }, isRelativePath: ${isRelativePath(
                node.text
              )}, isDirectory: ${isDirectory(
                sourceFile,
                node.text
              )}, extname: ${extname(node.text)}`
            );
          }

          // Ignore if it's not a relative path. ".." is a relative path for our purposes but is not considered as such by
          // isRelativePath(), so we need to let that exception fall through to the code below.
          if (node.text !== ".." && !isRelativePath(node.text)) return node;

          // Ignore if it's a JSON import
          const ext = extname(node.text);
          if (ext === JSON_EXT && ctx.getCompilerOptions().resolveJsonModule) {
            return node;
          }

          let updatedModulePath: ts.StringLiteral;
          if (isDirectory(sourceFile, node.text)) {
            // Add /index.<ext> if it's a directory
            updatedModulePath = factory.createStringLiteral(
              `${node.text}/index${options.extname}`
            );
          } else {
            // Replace/add the extension if it's a file
            const base =
              ext === JS_EXT ? trimSuffix(node.text, JS_EXT) : node.text;

            updatedModulePath = factory.createStringLiteral(
              `${base}${options.extname}`
            );
          }
          // console.log(`UPDATED ${node.text} to ${updatedModulePath.text}`);
          return updatedModulePath;
        }
      }

      // ESM dynamic import
      if (
        isCallExpression(node) &&
        node.expression.kind === SyntaxKind.ImportKeyword
      ) {
        const [firstArg, ...restArg] = node.arguments;
        if (!firstArg) return node;

        return factory.createCallExpression(
          node.expression,
          node.typeArguments,
          [updateModuleSpecifier(ctx, sourceFile, firstArg), ...restArg]
        );
      }

      // CommonJS require
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.escapedText === "require"
      ) {
        const [firstArg, ...restArgs] = node.arguments;
        if (!firstArg) return node;

        return factory.createCallExpression(
          node.expression,
          node.typeArguments,
          [updateModuleSpecifier(ctx, sourceFile, firstArg), ...restArgs]
        );
      }

      return visitEachChild(node, visitor, ctx);
    };

    return (file) => {
      if (file.kind === ts.SyntaxKind.Bundle) {
        throw new Error(`Doesn't work on bundles.`);
      }
      sourceFile = file;
      return visitNode(file, visitor) as ts.SourceFile;
    };
  };
}
