import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const API_ROOT = path.resolve(__dirname, '../../..')
const CENTRAL_HELPER = path.resolve(__dirname, '../seller-catalog-query.ts')

const EXPECTED_MIGRATED_CALL_COUNTS: Record<string, number> = {
  'admin/sellers/route.ts': 1,
  'internal/events-ticketing/redeem/route.ts': 1,
  'internal/ml/publish/route.ts': 1,
  'store/_utils/profit-apply-price.ts': 1,
  // Two identical metadata queries were consolidated into one typed read.
  'store/_utils/support-product-ensure.ts': 1,
  'store/_utils/support-seller-resolution.ts': 1,
  'store/envia/rates/route.ts': 1,
  'store/home/personalization/route.ts': 1,
  'store/listings/[id]/route.ts': 1,
  'store/listings/route.ts': 1,
  'store/sellers/[slug]/products/route.ts': 1,
  'store/sellers/me/orders/[id]/confirm-payment/route.ts': 1,
  'store/sellers/me/orders/[id]/pickup-appointment/route.ts': 1,
  'store/sellers/me/orders/[id]/proof/route.ts': 1,
  'store/sellers/me/orders/[id]/release-escrow/route.ts': 1,
  'store/sellers/me/orders/[id]/return-request/route.ts': 1,
  'store/sellers/me/orders/[id]/route.ts': 2,
  'store/sellers/me/orders/[id]/ship/route.ts': 1,
  'store/sellers/me/orders/[id]/tags/route.ts': 1,
  'store/sellers/me/orders/bulk-status/route.ts': 1,
  'store/sellers/me/orders/route.ts': 1,
}

const ORDER_OWNERSHIP_CALL_COUNTS: Record<string, number> = {
  'store/sellers/me/orders/route.ts': 1,
  'store/sellers/me/orders/[id]/route.ts': 2,
  'store/sellers/me/orders/[id]/confirm-payment/route.ts': 1,
  'store/sellers/me/orders/[id]/pickup-appointment/route.ts': 1,
  'store/sellers/me/orders/[id]/proof/route.ts': 1,
  'store/sellers/me/orders/[id]/release-escrow/route.ts': 1,
  'store/sellers/me/orders/[id]/return-request/route.ts': 1,
  'store/sellers/me/orders/[id]/ship/route.ts': 1,
  'store/sellers/me/orders/[id]/tags/route.ts': 1,
  'store/sellers/me/orders/bulk-status/route.ts': 1,
}

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(absolute)
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : []
  })
}

function relative(file: string): string {
  return path.relative(API_ROOT, file).split(path.sep).join('/')
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function directSellerProductFields(file: string): Array<{ field: string; line: number }> {
  const source = parse(file)
  const findings: Array<{ field: string; line: number }> = []

  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && (node.text === 'products.id' || node.text === 'products.metadata')) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push({ field: node.text, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}

function includeDeletedResolverCallCount(file: string): number {
  const source = parse(file)
  let count = 0

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'resolveSellerProductIds'
    ) {
      const options = node.arguments[2]
      if (
        options
        && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) =>
          ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === 'includeDeleted'
          && property.initializer.kind === ts.SyntaxKind.TrueKeyword
        )
      ) {
        count++
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return count
}

function typedResolverCallCount(file: string): number {
  const source = parse(file)
  const resolverNames = new Set([
    'resolveSellerProductIds',
    'resolveSellerProductIdsFromRemoteQuery',
    'resolveSellerProductMetadataRecords',
  ])
  let count = 0

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && resolverNames.has(node.expression.text)
    ) {
      count++
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return count
}

describe('seller→products null-slot inventory', () => {
  it('keeps every route-local map/find/loop/metadata traversal behind the typed helper', () => {
    const findings = sourceFiles(API_ROOT)
      .filter((file) => file !== CENTRAL_HELPER)
      .flatMap((file) =>
        directSellerProductFields(file).map((finding) => ({
          file: relative(file),
          ...finding,
        }))
      )

    if (findings.length) {
      throw new Error(
        `Direct seller→products traversal detected:\n${JSON.stringify(findings, null, 2)}\n`
        + 'Use resolveSellerProductIds() (or its typed metadata/legacy-query sibling) '
        + 'instead of a route-local map/find/loop/metadata access.',
      )
    }
  })

  it('keeps all 21 incident files on the central resolver boundary', () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_MIGRATED_CALL_COUNTS).map((file) => [
        file,
        typedResolverCallCount(path.join(API_ROOT, file)),
      ]),
    )

    expect(actual).toEqual(EXPECTED_MIGRATED_CALL_COUNTS)
  })

  it('keeps every order ownership read deleted-inclusive without widening live catalog reads', () => {
    const actual = Object.fromEntries(
      Object.keys(ORDER_OWNERSHIP_CALL_COUNTS).map((file) => [
        file,
        includeDeletedResolverCallCount(path.join(API_ROOT, file)),
      ]),
    )

    expect(actual).toEqual(ORDER_OWNERSHIP_CALL_COUNTS)
  })
})
