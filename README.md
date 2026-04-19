# XYZ监控哨兵

## 🚀 功能特点
- 定时检测
- PushDeer联动
- 服务端常驻运行
- 状态变动实时推送

## 🐳 Docker部署
Docker Run
```
docker run -d \
  --name xyzjk \
  -p 6821:6821 \
  -v xyzjk-data:/app/data \
  --restart always \
  cunpeng/xyzjk:1.01
```

## 📝 更新日志
- v1.00 (2024-04-15)
- v1.01 (2024-04-19)

## ⭐ 项目地址
- https://github.com/cunpeng/xyzjk

## 👨‍💻 赞赏作者
- https://github.com/user-attachments/assets/0926f261-1b00-4d8b-b9d3-49dcc980143b
