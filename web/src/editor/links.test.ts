import { describe, expect, it } from 'vitest'
import { isSafeHref, normalizeUrl } from './links.ts'

describe('normalizeUrl', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['  example.com/path  ', 'https://example.com/path'],
    ['localhost:3000', 'https://localhost:3000'],
    ['example.com:8080/x', 'https://example.com:8080/x'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@b.co', 'mailto:a@b.co'],
    ['someone@example.com', 'mailto:someone@example.com'],
    ['/notes/1', '/notes/1'],
    ['#top', '#top'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected)
  })

  it('never turns an unsafe scheme into a safe link', () => {
    expect(isSafeHref(normalizeUrl('javascript:alert(1)'))).toBe(false)
    expect(isSafeHref(normalizeUrl('data:text/html,x'))).toBe(false)
  })
})
