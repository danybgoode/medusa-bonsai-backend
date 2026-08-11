import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('seller creation idempotency claims', () => {
  it('serializes and re-reads self-create by Clerk identity', () => {
    const source = readFileSync(join(process.cwd(), 'src/api/store/sellers/me/route.ts'), 'utf8')
    const post = source.slice(source.indexOf('export async function POST'), source.indexOf('// PATCH'))
    expect(post).toMatch(/Modules\.LOCKING/)
    expect(post).toMatch(/seller-self-create:\$\{clerkUserId\}/)
    expect(post.indexOf('locking.execute')).toBeLessThan(post.indexOf('listSellers({ clerk_user_id: clerkUserId })'))
    expect(post.indexOf('listSellers({ clerk_user_id: clerkUserId })')).toBeLessThan(post.indexOf('createSellers'))
  })

  it('hashes, serializes, and re-reads importer source provenance', () => {
    const source = readFileSync(join(process.cwd(), 'src/api/internal/sellers/route.ts'), 'utf8')
    expect(source).toMatch(/createHash\('sha256'\)\.update\(sourceUrl\)/)
    expect(source).toMatch(/seller-import:\$\{claim\}/)
    const operation = source.slice(source.indexOf('const createOrRead'), source.indexOf('if (!sourceUrl)'))
    expect(operation.indexOf('listSellers({ source_url: sourceUrl }')).toBeLessThan(operation.indexOf('createSellers'))
  })
})
