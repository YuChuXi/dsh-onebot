/**
 * 斜杠命令面测试：/new、/session、/model、/compact 的路由与边界。
 * @module dsh-onebot/tests/commands
 */
import { describe, expect, it, vi } from 'vitest'

import { COMMANDS } from '../src/commands/index.js'
import { makeCmdHarness } from './helpers/bridge-harness.js'

describe('commands', () => {
  it('registers exactly /new, /session, /model, /compact', () => {
    expect(COMMANDS.map(c => c.name)).toEqual(['new', 'session', 'model', 'compact'])
  })

  it('routes /new before the model and starts a fresh session on the next message', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const oldSession = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(1)
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).not.toBe(oldSession)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('keeps unknown slash commands and path-like text on the model path', async () => {
    const h = await makeCmdHarness()
    h.sendText('/unknowncmd 参数')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('/unknowncmd')
    h.sendText('请查看 /tmp/x 文件')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('/tmp/x')
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('blocks slash commands for non-admin users', async () => {
    const h = await makeCmdHarness()
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 20002, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: '/new' } },
      ],
      sender: { user_id: 20002, nickname: '路人' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/model lists, switches this chat only, and rejects unknown models', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    ;(h.bridge as unknown as { deps: { llmCatalog?: unknown } }).deps.llmCatalog = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat' }, { provider: 'deepseek', id: 'deepseek-reasoner' }],
    }
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const chat = (h.bridge as unknown as { chats: Map<string, { agent: { model: { current: () => { provider: string; model: string } | undefined } } }> }).chats.get('private:10001')!

    h.sendText('/model')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('当前模型：deepseek/deepseek-chat'))).toBe(true)
    })
    h.sendText('/model deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切换。'))).toBe(true)
    })
    expect(chat.agent.model.current()).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(saveSelection).not.toHaveBeenCalled()
    h.sendText('/model deepseek no-such-model')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有这个模型'))).toBe(true)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/model --default rewrites the deployment default without touching the session selection', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const h = await makeCmdHarness({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection,
      },
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const chat = (h.bridge as unknown as { chats: Map<string, { agent: { model: { current: () => { provider: string; model: string } | undefined } } }> }).chats.get('private:10001')!
    h.sendText('/model --default deepseek deepseek-reasoner')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已设为默认。'))).toBe(true)
    })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(chat.agent.model.current()).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/compact forwards the host command with the 4-arg execute signature and replies only the outcome', async () => {
    const execute = vi.fn(async () => ({
      commandId: 'c1',
      result: { kind: 'success', text: '已压缩 12 条历史' },
    }))
    const h = await makeCmdHarness({ commands: { execute } })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/compact')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const call = execute.mock.calls[0] as unknown[] | undefined
    expect(call).toBeDefined()
    expect(call![1]).toBe('/compact')
    expect(call![2]).toEqual([])
    expect((call![3] as { aborted: boolean }).aborted).toBe(false)
    // 执行类回执只报结果；宿主的 result.text 不转发。
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已压缩。'))).toBe(true)
    })
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('已压缩 12 条历史'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
