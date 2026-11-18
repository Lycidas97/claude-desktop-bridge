import { globSync, readFileSync } from 'node:fs';
import ts from 'typescript';

function isMember(node, object, property) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === object
    && node.name.text === property;
}

function createsWithoutConstructor(node, className) {
  return ts.isCallExpression(node)
    && isMember(node.expression, 'Object', 'create')
    && node.arguments.length > 0
    && isMember(node.arguments[0], className, 'prototype');
}

const desktopTests = [
  'apps/desktop/src/**/*.test.ts',
  'apps/desktop/scripts/**/*.test.mjs',
  'scripts/fixtures/native-approval-host.ts',
];

const rules = [
  {
    id: 'desktop/controller-real-constructor',
    files: desktopTests,
    message: 'Use createControllerFixture(...) to run the real DesktopController constructor.',
    matches: node => createsWithoutConstructor(node, 'DesktopController'),
  },
  {
    id: 'desktop/claude-bridge-real-constructor',
    files: desktopTests,
    message: 'Use new ClaudeDesktopBridge(...) with test dependencies to run the real constructor.',
    matches: node => createsWithoutConstructor(node, 'ClaudeDesktopBridge'),
  },
  {
    id: 'ci/prebuild-protocol-source',
    files: ['scripts/relay-contract-probe.mjs'],
    message: 'Import from packages/protocol/src in this pre-build script.',
    matches(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        specifier = node.arguments[0];
      }
      return specifier && ts.isStringLiteralLike(specifier)
        && (/^@bridge\/protocol(?:\/|$)/u.test(specifier.text)
          || /(?:^|\/)packages\/protocol\/dist(?:\/|$)/u.test(specifier.text));
    },
  },
];

for (const { id, files, message, matches } of rules) {
  for (const path of globSync(files).sort()) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
    ts.forEachChild(file, function visit(node) {
      if (matches(node)) {
        const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
        console.error(`${path}:${line + 1}:${character + 1} [${id}] ${message}`);
        process.exitCode = 1;
      }
      ts.forEachChild(node, visit);
    });
  }
}
