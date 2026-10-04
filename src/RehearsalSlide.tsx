export default function RehearsalSlide() {
  return <div className="rehearsal-slide" aria-label="Sample slide fitted entirely outside the caption strip">
    <svg viewBox="0 0 1600 900" role="img" aria-labelledby="sample-slide-title">
      <title id="sample-slide-title">Sample presentation: GitHub API demonstration</title>
      <rect width="1600" height="900" fill="#f4f4ec" />
      <text x="110" y="130" fill="#5f633b" fontSize="32" fontFamily="sans-serif">STAGE · SAMPLE PRESENTATION</text>
      <text x="110" y="260" fill="#252819" fontSize="78" fontWeight="600" fontFamily="sans-serif">The GitHub API</text>
      <text x="110" y="340" fill="#626556" fontSize="36" fontFamily="sans-serif">A live demonstration, followed by your questions.</text>
      <line x1="110" y1="700" x2="1490" y2="700" stroke="#b6b9a7" strokeWidth="3" />
      {[80, 140, 200, 270, 330].map((height, index) => <rect key={height} x={150 + index * 220} y={700 - height} width="140" height={height} rx="8" fill={index === 4 ? '#656d31' : '#bfc5a6'} />)}
      <text x="110" y="805" fill="#626556" fontSize="30" fontFamily="sans-serif">Sample slide · All content stays visible</text>
      <text x="1440" y="805" fill="#626556" fontSize="30" fontFamily="sans-serif">01</text>
    </svg>
  </div>;
}
