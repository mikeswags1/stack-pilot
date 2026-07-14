import assert from 'node:assert/strict'
import {
  decodeHtmlEntitiesDeep,
  hasEncodedTitleArtifact,
  repairEncodedEbayTitle,
} from '../lib/html-entities.ts'

const cases = [
  ["Women&#x27;s", "Women's"],
  ["Women&#39;s", "Women's"],
  ["Women&apos;s", "Women's"],
  ["Women&amp;#x27;s", "Women's"],
  ["Women&amp;amp;#x27;s", "Women's"],
  ["Women&#8217;s", "Women's"],
  ["Women&amp;#x2019;s", "Women's"],
  ['R&amp;D', 'R&D'],
  ['R&amp;amp;D', 'R&D'],
  ['New&nbsp;&nbsp;Title', 'New  Title'],
]

for (const [input, expected] of cases) {
  assert.equal(decodeHtmlEntitiesDeep(input), expected, input)
  assert.equal(decodeHtmlEntitiesDeep(decodeHtmlEntitiesDeep(input)), expected, `${input} is idempotent`)
}

assert.equal(hasEncodedTitleArtifact('Hunting & Fishing'), false)
assert.equal(hasEncodedTitleArtifact('Hunting &amp; Fishing'), true)
assert.equal(hasEncodedTitleArtifact('Women&#8217;s'), true)
assert.equal(repairEncodedEbayTitle('  Women&amp;#x27;s   Shirt  '), "Women's Shirt")
assert.equal(repairEncodedEbayTitle('Hunting & Fishing'), 'Hunting & Fishing')
assert.doesNotThrow(() => decodeHtmlEntitiesDeep('Bad &#x110000; entity'))

const xmlEscape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
assert.equal(xmlEscape(decodeHtmlEntitiesDeep("Women's R&amp;D")), "Women's R&amp;D")

console.log('Title entity regression checks passed.')
