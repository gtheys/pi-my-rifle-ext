import { expect, test } from 'bun:test'
import { attendeeLink, parseAttendee, resolveAttendee } from './index.ts'

// Real Graph attendee shapes: Asian names carry a bracketed nickname,
// some leak zero-width spaces (U+200B).
const ATTENDEES = [
  'Lam [Liam] Pham',
  'Jirawat [Jo] Boonkumnerd',
  'Geert Theys',
  'Đinh Ngọc Anh',
  'Natthawarin\u200b [Nut] Kitthanatsakul\u200b',
]

test('parseAttendee: bracketed nickname → full + nickname', () => {
  expect(parseAttendee('Lam [Liam] Pham')).toEqual({
    full: 'Lam Pham',
    nickname: 'Liam',
  })
})

test('parseAttendee: no bracket → full only, null nickname', () => {
  expect(parseAttendee('Geert Theys')).toEqual({
    full: 'Geert Theys',
    nickname: null,
  })
})

test('parseAttendee: strips zero-width spaces', () => {
  expect(parseAttendee('Natthawarin\u200b [Nut] Kitthanatsakul\u200b')).toEqual(
    {
      full: 'Natthawarin Kitthanatsakul',
      nickname: 'Nut',
    },
  )
})

test('bracketed attendee (raw) → [[Full|Nickname]]', () => {
  expect(attendeeLink(ATTENDEES, 'Lam [Liam] Pham')).toBe('[[Lam Pham|Liam]]')
})

test('bracketed attendee mentioned by nickname → same [[Full|Nickname]]', () => {
  expect(attendeeLink(ATTENDEES, 'Liam')).toBe('[[Lam Pham|Liam]]')
})

test('bracketed attendee mentioned by de-bracketed full → same link', () => {
  expect(attendeeLink(ATTENDEES, 'Lam Pham')).toBe('[[Lam Pham|Liam]]')
})

test('bracketed attendee matched by last name still shows nickname alias', () => {
  expect(attendeeLink(ATTENDEES, 'Boonkumnerd')).toBe(
    '[[Jirawat Boonkumnerd|Jo]]',
  )
})

test('zero-width-space Graph name → clean [[Full|Nickname]]', () => {
  expect(
    attendeeLink(ATTENDEES, 'Natthawarin\u200b [Nut] Kitthanatsakul\u200b'),
  ).toBe('[[Natthawarin Kitthanatsakul|Nut]]')
})

test('plain full name → plain [[Full]]', () => {
  expect(attendeeLink(ATTENDEES, 'Geert Theys')).toBe('[[Geert Theys]]')
})

test('plain first-name short mention → [[Full|Short]]', () => {
  expect(attendeeLink(ATTENDEES, 'Geert')).toBe('[[Geert Theys|Geert]]')
})

test('case-insensitive full match keeps canonical casing', () => {
  expect(resolveAttendee(ATTENDEES, 'geert theys')).toEqual({
    full: 'Geert Theys',
    alias: null,
  })
})

test('unknown name links to itself', () => {
  expect(attendeeLink(ATTENDEES, 'Sam')).toBe('[[Sam]]')
})

test('empty attendees list → name links to itself', () => {
  expect(attendeeLink([], 'Geert')).toBe('[[Geert]]')
})
