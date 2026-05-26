import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'aliyun-tokenplan',
  label: 'Aliyun Bailian TokenPlan',
  classification: 'anthropic',
  defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
  defaultModel: 'qwen3.7-max',
  requiredEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  setup: {
    requiresAuth: true,
    authMode: 'token',
    credentialEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  },
  transportConfig: {
    kind: 'anthropic-native',
  },
  preset: {
    id: 'aliyun-tokenplan',
    description: 'Aliyun Bailian TokenPlan — Anthropic-compatible (Bearer auth)',
    label: 'Aliyun Bailian TokenPlan',
    apiKeyEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
    baseUrlEnvVars: ['ANTHROPIC_BASE_URL'],
    modelEnvVars: ['ANTHROPIC_MODEL'],
  },
  isFirstParty: false,
  usage: { supported: false },
})
