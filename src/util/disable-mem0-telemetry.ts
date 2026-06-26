// mem0ai 默认会发送匿名使用统计（telemetry）到 PostHog，在国内网络环境下经常连接超时并打印错误。
// 该模块必须在任何 mem0ai/oss 导入之前被加载，使环境变量在模块初始化时生效。
process.env.MEM0_TELEMETRY = 'false';
