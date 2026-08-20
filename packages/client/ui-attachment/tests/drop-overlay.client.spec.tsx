// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DropOverlay } from '../src/DropOverlay.tsx'

afterEach(cleanup)

describe('DropOverlay', () => {
  it('portals the invitation with its title and limits desc to the body', () => {
    const view = render(
      <DropOverlay
        disabled={false}
        labels={{ title: '图片拖动到此处即可添加', desc: '最多 20 张，每张 5MB', close: '关闭拖放提示' }}
        onDismiss={() => {}}
      />,
    )
    const overlay = view.getByRole('status')
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.textContent).toContain('图片拖动到此处即可添加')
    expect(overlay.textContent).toContain('最多 20 张，每张 5MB')
  })

  it('omits the desc line when none is resolved', () => {
    const view = render(
      <DropOverlay
        disabled={false}
        labels={{ title: '图片拖动到此处即可添加', close: '关闭拖放提示' }}
        onDismiss={() => {}}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('图片拖动到此处即可添加')
  })

  it('drops the desc and switches the illustration while disabled', () => {
    const enabled = render(
      <DropOverlay disabled={false} labels={{ title: '拖入', desc: '限制', close: '关闭' }} onDismiss={() => {}} />,
    )
    const enabledSvg = enabled.getByRole('status').querySelector('svg[width="115"]')!.innerHTML
    enabled.unmount()
    const disabled = render(
      <DropOverlay disabled labels={{ title: '当前无法添加图片', desc: '限制', close: '关闭' }} onDismiss={() => {}} />,
    )
    const overlay = disabled.getByRole('status')
    expect(overlay.textContent).toBe('当前无法添加图片')
    expect(overlay.querySelector('svg[width="115"]')!.innerHTML).not.toBe(enabledSvg)
  })

  it('offers click and Escape recovery when the browser misses the drag end', () => {
    const dismiss = vi.fn()
    const view = render(
      <DropOverlay
        disabled={false}
        labels={{ title: '拖入', close: '关闭拖放提示' }}
        onDismiss={dismiss}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '关闭拖放提示' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dismiss).toHaveBeenCalledTimes(2)
  })
})
