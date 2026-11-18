import { globSync, readFileSync } from 'node:fs';
import ts from 'typescript';

function isMember(node, object, property) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === object
    && node.name.text === property;
}

const rules = [
  {
    id: 'desktop/controller-real-constructor',
    files: [
      'apps/desktop/src/**/*.test.ts',
      'apps/desktop/scripts/**/*.test.mjs',
      'scripts/fixtures/native-approval-host.ts',
    ],
    message: 'Use createControllerFixture(...) to run the real DesktopController constructor.',
    matches(node) {
      return ts.isCallExpression(node)
        && isMember(node.expression, 'Object', 'create')
        && node.arguments.length > 0
        && isMember(node.arguments[0], 'DesktopController', 'prototype');
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
