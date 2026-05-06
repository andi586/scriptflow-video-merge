# 4-Emotion Video Generator API

## 一键生成4个情绪视频

### Endpoint
```
POST https://scriptflow-video-merge-production.up.railway.app/api/generate-emotions
```

### Request Body
```json
{
  "imageUrl": "https://your-image-url.jpg",
  "projectId": "optional-project-id"
}
```

### Response
```json
{
  "success": true,
  "data": {
    "sad": "https://replicate.delivery/pbxt/video1.mp4",
    "surprised": "https://replicate.delivery/pbxt/video2.mp4",
    "scared": "https://replicate.delivery/pbxt/video3.mp4",
    "neutral": "https://replicate.delivery/pbxt/video4.mp4"
  }
}
```

## 技术细节

### 使用的模型
- **Replicate Seedance 1 Lite**
- Model ID: `bytedance/seedance-1-lite`

### 生成参数
- **Duration**: 5 seconds
- **Resolution**: 720p
- **FPS**: 24
- **Camera**: Fixed (no camera movement)

### 4个情绪 Prompts

1. **Sad (悲伤)**
   ```
   A close-up portrait video of the same person from the input image, 
   very subtle facial emotion change to sad, minimal movement, 
   natural blinking, cinematic lighting.
   ```

2. **Surprised (惊讶)**
   ```
   A close-up portrait video of the same person from the input image 
   becoming surprised, eyes widening, minimal movement, natural blinking.
   ```

3. **Scared (恐惧)**
   ```
   A close-up portrait video of the same person from the input image 
   becoming scared, tense expression, subtle fear, minimal movement.
   ```

4. **Neutral (中性)**
   ```
   A calm neutral face of the same person from the input image, 
   minimal movement, slight blinking.
   ```

## 使用示例

### cURL
```bash
curl -X POST https://scriptflow-video-merge-production.up.railway.app/api/generate-emotions \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/photo.jpg"
  }'
```

### JavaScript/Node.js
```javascript
const response = await fetch('https://scriptflow-video-merge-production.up.railway.app/api/generate-emotions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageUrl: 'https://example.com/photo.jpg',
    projectId: 'optional-project-id'
  })
});

const result = await response.json();
console.log('Generated videos:', result.data);
// {
//   sad: 'https://...',
//   surprised: 'https://...',
//   scared: 'https://...',
//   neutral: 'https://...'
// }
```

### Python
```python
import requests

response = requests.post(
    'https://scriptflow-video-merge-production.up.railway.app/api/generate-emotions',
    json={
        'imageUrl': 'https://example.com/photo.jpg'
    }
)

result = response.json()
print('Generated videos:', result['data'])
```

## 接入 ScriptFlow 后端

### 在 app/api/movie/generate/route.ts 中使用

```typescript
// 生成4个情绪视频
const emotionResponse = await fetch(
  `${process.env.RAILWAY_FFMPEG_URL}/api/generate-emotions`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: uploadedPhotoUrl,
      projectId: movieId
    })
  }
);

const emotionData = await emotionResponse.json();

if (emotionData.success) {
  const { sad, surprised, scared, neutral } = emotionData.data;
  
  // 使用这些视频作为 hook 视频的素材
  // 或者保存到数据库供后续使用
}
```

## 性能

- **并行生成**: 4个视频同时生成
- **总耗时**: ~30-60秒 (取决于 Replicate 队列)
- **成本**: ~$0.20 per 4-video set (Seedance pricing)

## 错误处理

如果某个情绪生成失败，API 仍会返回成功的视频：

```json
{
  "success": true,
  "data": {
    "sad": "https://...",
    "surprised": null,  // 这个失败了
    "scared": "https://...",
    "neutral": "https://..."
  }
}
```

## 环境变量

确保 Railway 服务配置了：
```
REPLICATE_API_TOKEN=r8_xxx...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...
```

## 部署状态

✅ **已部署到 Railway**
- Service: scriptflow-video-merge
- URL: https://scriptflow-video-merge-production.up.railway.app
- Status: Running
- Endpoint: `/api/generate-emotions`
