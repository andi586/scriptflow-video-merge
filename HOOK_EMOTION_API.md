# Hook Emotion Video Generator API

## 根据模板生成单个情绪视频

### Endpoint
```
POST https://scriptflow-video-merge-production.up.railway.app/api/generate-hook-emotion
```

### 特点
- ✅ **只生成1个视频** (不是4个)
- ✅ **成本降低75%**: $0.30 instead of $1.20
- ✅ **情绪自动匹配模板**: 根据 template_id 自动选择合适的情绪
- ✅ **使用 Seedance 1 Lite**: 高质量面部动画

### Request Body
```json
{
  "imageUrl": "https://your-image-url.jpg",
  "template_id": "she_didnt_choose_you"
}
```

### Response
```json
{
  "success": true,
  "emotion": "sad",
  "videoUrl": "https://replicate.delivery/pbxt/xxx.mp4"
}
```

## Template → Emotion 映射

| Template ID | Emotion | 说明 |
|------------|---------|------|
| `she_didnt_choose_you` | sad | 悲伤表情 |
| `phone_3am` | sad | 悲伤表情 |
| `lost_someone` | sad | 悲伤表情 |
| `dog_last_words` | sad | 悲伤表情 |
| `what_could_have_been` | sad | 悲伤表情 |
| `last_person` | sad | 悲伤表情 |
| `group_chat` | sad | 悲伤表情 |
| `parallel_universe` | neutral | 中性表情 |
| `future_you` | scared | 恐惧表情 |
| `future_warning` | scared | 恐惧表情 |
| `friend_betrayal` | surprised | 惊讶表情 |
| `breaking_news` | surprised | 惊讶表情 |

## 使用示例

### cURL
```bash
curl -X POST https://scriptflow-video-merge-production.up.railway.app/api/generate-hook-emotion \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/photo.jpg",
    "template_id": "she_didnt_choose_you"
  }'
```

### JavaScript/Node.js
```javascript
const response = await fetch(
  'https://scriptflow-video-merge-production.up.railway.app/api/generate-hook-emotion',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: 'https://example.com/photo.jpg',
      template_id: 'she_didnt_choose_you'
    })
  }
);

const result = await response.json();
console.log('Emotion:', result.emotion);  // "sad"
console.log('Video URL:', result.videoUrl);
```

## 接入 ScriptFlow 后端

### 在 app/api/movie/generate/route.ts 中使用

```typescript
// 生成情绪视频作为 hook
const hookResponse = await fetch(
  `${process.env.RAILWAY_FFMPEG_URL}/api/generate-hook-emotion`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: uploadedPhotoUrl,
      template_id: selectedTemplate  // 'she_didnt_choose_you', 'future_you', etc.
    })
  }
);

const hookData = await hookResponse.json();

if (hookData.success) {
  // 使用生成的情绪视频作为 hook
  const hookVideoUrl = hookData.videoUrl;
  const emotion = hookData.emotion;
  
  // 保存到数据库
  await supabase
    .from('movies')
    .update({ 
      hook_video_url: hookVideoUrl,
      hook_emotion: emotion 
    })
    .eq('id', movieId);
}
```

## 成本对比

### 旧方案 (4个情绪视频)
- 生成数量: 4个视频
- 成本: ~$1.20 per movie
- 耗时: ~60-90秒

### 新方案 (1个情绪视频)
- 生成数量: 1个视频
- 成本: ~$0.30 per movie
- 耗时: ~15-30秒
- **节省75%成本** ✅

## 技术细节

### Seedance 参数
```javascript
{
  prompt: "A close-up portrait video...",
  image: imageUrl,
  duration: 5,        // 5秒视频
  resolution: "720p", // 720p分辨率
  fps: 24,           // 24帧/秒
  camera_fixed: true  // 固定镜头
}
```

### 4种情绪 Prompts

1. **sad (悲伤)**
   ```
   A close-up portrait video of the same person from the input image, 
   very subtle facial emotion change to sad, minimal movement, 
   natural blinking, cinematic lighting.
   ```

2. **surprised (惊讶)**
   ```
   A close-up portrait video of the same person from the input image 
   becoming surprised, eyes widening, minimal movement, natural blinking.
   ```

3. **scared (恐惧)**
   ```
   A close-up portrait video of the same person from the input image 
   becoming scared, tense expression, subtle fear, minimal movement.
   ```

4. **neutral (中性)**
   ```
   A calm neutral face of the same person from the input image, 
   minimal movement, slight blinking.
   ```

## 错误处理

```javascript
try {
  const response = await fetch('/api/generate-hook-emotion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, template_id })
  });
  
  const data = await response.json();
  
  if (!data.success) {
    console.error('Generation failed:', data.error);
    // Fallback to static image or default video
  }
} catch (error) {
  console.error('API call failed:', error);
  // Fallback logic
}
```

## 环境变量

确保 Railway 服务配置了：
```
REPLICATE_API_TOKEN=r8_xxx...
```

## 部署状态

✅ **已部署到 Railway**
- Service: scriptflow-video-merge
- URL: https://scriptflow-video-merge-production.up.railway.app
- Endpoint: `/api/generate-hook-emotion`
- Status: Running

## 优势总结

1. **成本优化**: 只生成1个视频，节省75%成本
2. **智能匹配**: 根据模板自动选择合适的情绪
3. **更快速度**: 单个视频生成更快
4. **简化逻辑**: 不需要管理4个视频URL
5. **更好体验**: 情绪与故事模板完美匹配
