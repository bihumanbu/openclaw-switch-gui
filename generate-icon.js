const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const toIco = require('to-ico');

// 创建龙虾 SVG 图标
const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" fill="#0f1117"/>
  <ellipse cx="128" cy="140" rx="45" ry="55" fill="#ff6b6b" stroke="#cc5555" stroke-width="2"/>
  <ellipse cx="128" cy="70" rx="40" ry="35" fill="#ff6b6b" stroke="#cc5555" stroke-width="2"/>
  <circle cx="115" cy="55" r="6" fill="#ffff00"/>
  <circle cx="141" cy="55" r="6" fill="#ffff00"/>
  <circle cx="115" cy="55" r="3" fill="#000"/>
  <circle cx="141" cy="55" r="3" fill="#000"/>
  <line x1="110" y1="45" x2="85" y2="25" stroke="#ff6b6b" stroke-width="3" stroke-linecap="round"/>
  <line x1="146" y1="45" x2="171" y2="25" stroke="#ff6b6b" stroke-width="3" stroke-linecap="round"/>
  <g>
    <line x1="100" y1="100" x2="75" y2="85" stroke="#ff6b6b" stroke-width="4" stroke-linecap="round"/>
    <path d="M 75 85 L 70 80 L 75 88" fill="#ff6b6b" stroke="#cc5555" stroke-width="1"/>
    <line x1="156" y1="100" x2="181" y2="85" stroke="#ff6b6b" stroke-width="4" stroke-linecap="round"/>
    <path d="M 181 85 L 186 80 L 181 88" fill="#ff6b6b" stroke="#cc5555" stroke-width="1"/>
  </g>
  <ellipse cx="128" cy="155" rx="35" ry="40" fill="#ff8888" opacity="0.6"/>
  <path d="M 110 190 Q 90 220 95 240 Q 100 215 128 235 Q 156 215 161 240 Q 166 220 146 190" 
        fill="#ff6b6b" stroke="#cc5555" stroke-width="2"/>
  <ellipse cx="120" cy="100" rx="15" ry="20" fill="#ff9999" opacity="0.4"/>
</svg>`;

async function generateIcon() {
  try {
    const svgPath = path.join(__dirname, 'src', 'icon.svg');
    const icoPath = path.join(__dirname, 'src', 'icon.ico');

    fs.writeFileSync(svgPath, svgContent);
    console.log('✓ SVG 图标已创建');

    // 生成多个尺寸的 PNG
    const sizes = [256, 128, 64, 48, 32, 16];
    const images = [];
    
    for (const size of sizes) {
      const buffer = await sharp(Buffer.from(svgContent))
        .resize(size, size)
        .png()
        .toBuffer();
      images.push(buffer);
    }
    console.log('✓ PNG 图标已生成');

    // 转换为 ICO
    const icoBuffer = await toIco(images);
    fs.writeFileSync(icoPath, icoBuffer);
    console.log('✓ ICO 图标已创建:', icoPath);
    console.log('✓ 龙虾图标生成完成！');
  } catch (err) {
    console.error('❌ 生成失败:', err.message);
    console.error(err);
    process.exit(1);
  }
}

generateIcon();
