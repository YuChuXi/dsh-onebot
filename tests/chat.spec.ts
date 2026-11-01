import { describe, expect, it } from 'vitest'
import {
  buildChatId, splitChatId, sessionIdForChat, classifyUserRole, dmAllowed, groupAllowed,
} from '../src/chat/index.js'
import type { AccessPolicyConfig } from '../src/chat/index.js'

function policy(overrides: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return {
    dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
    adminUsers: ['10001'], allowAllUsers: false, requireMention: true, ...overrides,
  }
}

describe('chat ids', () => {
  it('round-trips', () => {
    expect(buildChatId('private', '123')).toBe('private:123')
    expect(buildChatId('group', '456')).toBe('group:456')
    expect(splitChatId('private:123')).toEqual({ kind: 'private', target: '123' })
    expect(splitChatId('group:456')).toEqual({ kind: 'group', target: '456' })
    expect(splitChatId('789')).toEqual({ kind: 'private', target: '789' })
  })
  it('derives session ids', () => {
    expect(sessionIdForChat('private:123')).toBe('onebot-private-123')
    expect(sessionIdForChat('group:456')).toBe('onebot-group-456')
  })
})

describe('roles and policy', () => {
  it('classifies admin vs member', () => {
    expect(classifyUserRole('10001', ['10001'])).toBe('admin')
    expect(classifyUserRole('20002', ['10001'])).toBe('member')
  })
  it('dm open admits admins only', () => {
    expect(dmAllowed('10001', policy())).toBe(true)
    expect(dmAllowed('20002', policy())).toBe(false)
  })
  it('dm allowlist admits allowFrom', () => {
    const p = policy({ dmPolicy: 'allowlist', allowFrom: ['20002'] })
    expect(dmAllowed('20002', p)).toBe(true)
    expect(dmAllowed('10001', p)).toBe(false)
  })
  it('dm disabled admits nobody', () => {
    const p = policy({ dmPolicy: 'disabled' })
    expect(dmAllowed('10001', p)).toBe(false)
  })
  it('allowAllUsers bypasses', () => {
    expect(dmAllowed('20002', policy({ allowAllUsers: true }))).toBe(true)
  })
  it('group policies', () => {
    expect(groupAllowed('1', policy())).toBe(true)
    expect(groupAllowed('1', policy({ groupPolicy: 'disabled' }))).toBe(false)
    expect(groupAllowed('1', policy({ groupPolicy: 'allowlist', groupAllowFrom: ['1'] }))).toBe(true)
    expect(groupAllowed('2', policy({ groupPolicy: 'allowlist', groupAllowFrom: ['1'] }))).toBe(false)
  })
})
