bot

## 功能

- [x] 接收、存储消息，并打包成simple-id格式
- [x] 处理消息中的图片
- [x] 回复消息（@触发 + 闲时触发，支持深度研究）
  
## 启动

```bash
cp config.example.ts config.ts

// 然后修改配置文件（必须填写 ai.assignments.reply 和 ai.assignments.deep_research）

yarn web:build && yarn start
```