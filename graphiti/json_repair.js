const {jsonrepair, JSONRepairError} = require('jsonrepair');

/**
 * 用 jsonrepair 修复模型返回的 JSON 文本。
 * jsonrepair 不接受根值之后的额外内容（模型输出完整 JSON 后继续输出尾随文字），
 * 此时按其给出的出错位置截断后重试，得到根值自身的修复结果。
 */
function repairJsonText (content) {
    try {
        return jsonrepair(content);
    } catch (err) {
        if (!(err instanceof JSONRepairError) || !(err.position > 0)) {
            throw err;
        }
        return jsonrepair(content.slice(0, err.position));
    }
}

exports.repairJsonText = repairJsonText;
