import { foldBuyerEmails } from '../buyers/route'

/**
 * The buyer recipient list feeds an admin BROADCAST. Every defect here sends real
 * mail to the wrong people, or twice to the right ones — so the folding is pure and
 * tested, and the route is a thin shell around it.
 */
describe('foldBuyerEmails', () => {
  it('de-duplicates case-insensitively — one inbox, one email', () => {
    // `Ana@x.com` and `ana@x.com` are the same person. Sending twice is the failure.
    const { emails } = foldBuyerEmails([
      { email: 'Ana@example.com' },
      { email: 'ana@example.com' },
      { email: 'ANA@EXAMPLE.COM' },
    ])
    expect(emails).toEqual(['Ana@example.com'])
  })

  it('keeps the FIRST-seen spelling for display', () => {
    const { emails } = foldBuyerEmails([{ email: 'Bob@Example.com' }, { email: 'bob@example.com' }])
    expect(emails).toEqual(['Bob@Example.com'])
  })

  it('drops blanks, whitespace and non-addresses rather than emitting empty recipients', () => {
    // An empty recipient is a send that cannot arrive but still reports as attempted.
    const { emails } = foldBuyerEmails([
      { email: '' },
      { email: '   ' },
      { email: 'not-an-email' },
      { email: null },
      { email: undefined },
      { email: 42 },
      {},
      { email: 'real@example.com' },
    ])
    expect(emails).toEqual(['real@example.com'])
  })

  it('trims surrounding whitespace before comparing', () => {
    const { emails } = foldBuyerEmails([{ email: '  dup@example.com  ' }, { email: 'dup@example.com' }])
    expect(emails).toEqual(['dup@example.com'])
  })

  it('returns a stable sorted order, so two previews of one list agree', () => {
    const { emails } = foldBuyerEmails([{ email: 'c@x.com' }, { email: 'a@x.com' }, { email: 'b@x.com' }])
    expect(emails).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('reports how many rows it scanned, separately from how many it kept', () => {
    // "5 recipients" and "we looked at 5 orders" are different facts; the caller shows
    // both so a small list from a big scan does not read as a small customer base.
    const { emails, scanned } = foldBuyerEmails([
      { email: 'a@x.com' }, { email: 'a@x.com' }, { email: '' },
    ])
    expect(emails).toHaveLength(1)
    expect(scanned).toBe(3)
  })

  it('is total — an empty input is an empty list, not a throw', () => {
    expect(foldBuyerEmails([])).toEqual({ emails: [], scanned: 0 })
  })
})
