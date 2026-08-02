import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('responsive styles', () => {
  it('狭い画面では1列配置と画面幅いっぱいの操作に切り替える', () => {
    expect(styles).toContain('@media (max-width: 560px)')
    expect(styles).toMatch(/\.form-grid,[\s\S]*\.choice-grid[\s\S]*grid-template-columns: 1fr;/u)
    expect(styles).toMatch(/\.button:not\(\.button--small\)[\s\S]*width: 100%;/u)
  })
})
