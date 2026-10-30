// A perspective schematic, deliberately separate from sensor inference.
// Its curves/split have no geographic or measured distance meaning.
export class TrackView {
  constructor(element) {
    this.element = element;
    element.innerHTML = `<svg viewBox="0 0 350 200" aria-hidden="true">
      <defs><linearGradient id="railGlow" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#469bbb"/><stop offset="1" stop-color="#a0d9e9"/></linearGradient></defs>
      <path d="M18 162L182 194L335 83L171 51Z" fill="#1a3042" opacity=".35"/>
      <g fill="none" stroke="#375166" stroke-width=".6" opacity=".45"><path d="M45 142L208 174M80 120L243 152M115 98L278 130M150 76L313 108M57 170L212 59M100 179L255 68M143 187L298 77"/></g>
      <path id="commonTrack" d="M55 167 C91 157 99 121 142 110 S183 91 191 76" fill="none" stroke="#10202f" stroke-width="16"/>
      <path id="leftTrack" d="M191 76 C189 62 165 59 156 40 L149 27" fill="none" stroke="#10202f" stroke-width="12"/>
      <path id="rightTrack" d="M191 76 C208 64 237 69 259 48 L273 35" fill="none" stroke="#10202f" stroke-width="12"/>
      <g id="sleepers" stroke="#617588" stroke-width="2" opacity=".5"></g>
      <g fill="none" stroke="url(#railGlow)" stroke-width="3"><path d="M55 163 C89 153 98 117 140 106 S178 88 187 76"/><path d="M55 171 C94 161 101 125 144 114 S188 94 195 77"/></g>
      <g id="branchLeft" fill="none" stroke="#7b9cb4" stroke-width="2"><path d="M187 76 C185 62 161 59 152 40 L145 27"/><path d="M195 76 C193 62 169 59 160 40 L153 27"/></g>
      <g id="branchRight" fill="none" stroke="#7b9cb4" stroke-width="2"><path d="M187 76 C204 61 233 65 255 46 L269 32"/><path d="M195 78 C212 68 241 73 263 51 L277 38"/></g>
      <path id="positionRange" fill="none" stroke="#9edcf7" stroke-width="18" opacity=".13" stroke-linecap="round"/>
      <path id="alternativeRange" fill="none" stroke="#9edcf7" stroke-width="18" opacity=".13" stroke-linecap="round"/>
      <g id="trainMarker"><ellipse rx="14" ry="8" fill="#62cff7" opacity=".15" cy="6"/><path d="M-8 0L0 -5L8 0V9L0 14L-8 9Z" fill="#bceafb" stroke="#79cbe8"/><path d="M0 3L8 0V9L0 14Z" fill="#3d91b6"/><path d="M-5 3L-1 5V8L-5 6Z" fill="#173b56"/></g>
      <g id="alternativeMarker" opacity=".45"><circle r="5" fill="#8db9d0" stroke="#def7ff" stroke-dasharray="2 2"/></g>
      <g fill="#9bb2c8" font-size="10" font-family="system-ui"><text x="25" y="193">Stockwell</text><text x="114" y="18">Left</text><text x="279" y="28">Right</text><text x="226" y="97" font-size="8" fill="#708aa3">Brixton</text></g>
    </svg>`;
    this.common = element.querySelector("#commonTrack");
    this.left = element.querySelector("#leftTrack");
    this.right = element.querySelector("#rightTrack");
    const sleepers = element.querySelector("#sleepers");
    for (const path of [this.common, this.left, this.right]) {
      const length = path.getTotalLength();
      for (let n = 8; n < length - 3; n += 9) {
        const a = path.getPointAtLength(n),
          b = path.getPointAtLength(n + 1),
          dx = b.x - a.x,
          dy = b.y - a.y,
          k = 7 / Math.hypot(dx, dy);
        const line = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        for (const [key, value] of Object.entries({
          x1: a.x - dy * k,
          y1: a.y + dx * k,
          x2: a.x + dy * k,
          y2: a.y - dx * k,
        }))
          line.setAttribute(key, value);
        sleepers.appendChild(line);
      }
    }
    this.render(null, null);
  }
  point(progress, branch) {
    // Display spacing only; .72 is an illustrative layout junction, NOT an inference.
    const p = Math.min(1, Math.max(0, progress));
    const path =
      p <= 0.72 ? this.common : branch === "left" ? this.left : this.right;
    return path.getPointAtLength(
      path.getTotalLength() * (p <= 0.72 ? p / 0.72 : (p - 0.72) / 0.28),
    );
  }
  render(position, prediction) {
    const available = Number.isFinite(position?.progress);
    const p = available ? position.progress : 0;
    const hasPrediction =
      !!prediction?.prediction || Number.isFinite(prediction?.pLeft);
    const branch =
      prediction?.prediction || (prediction?.pLeft >= 0.5 ? "left" : "right");
    const firm = prediction?.firm === true;
    const marker = this.element.querySelector("#trainMarker"),
      alt = this.element.querySelector("#alternativeMarker");
    const selectedProgress = position?.hypotheses?.[branch]?.progress ?? p;
    cancelAnimationFrame(this.animation);
    const from = this.displayProgress ?? selectedProgress;
    const started = performance.now();
    const animate = (now) => {
      const fraction =
        available && !matchMedia("(prefers-reduced-motion: reduce)").matches
          ? Math.min(1, (now - started) / 800)
          : 1;
      this.displayProgress = from + (selectedProgress - from) * fraction;
      const point = this.point(this.displayProgress, branch);
      marker.style.transform = `translate(${point.x}px,${point.y - 6}px)`;
      if (fraction < 1) this.animation = requestAnimationFrame(animate);
    };
    animate(started);
    marker.setAttribute(
      "opacity",
      available ? (hasPrediction ? "1" : ".55") : ".3",
    );
    const otherBranch = branch === "left" ? "right" : "left";
    const other = this.point(
      position?.hypotheses?.[otherBranch]?.progress ?? p,
      otherBranch,
    );
    alt.setAttribute("transform", `translate(${other.x} ${other.y})`);
    alt.style.display =
      available && Math.max(p, selectedProgress) > 0.72 && !firm ? "" : "none";
    alt.setAttribute("opacity", hasPrediction ? ".45" : ".8");
    this.element
      .querySelector("#branchLeft")
      .setAttribute(
        "stroke",
        firm && branch === "left" ? "#a1e5fa" : "#7b9cb4",
      );
    this.element
      .querySelector("#branchRight")
      .setAttribute(
        "stroke",
        firm && branch === "right" ? "#a1e5fa" : "#7b9cb4",
      );
    let range = "";
    if (available) {
      for (let q = position.lower; q <= position.upper + 0.005; q += 0.01) {
        const a = this.point(Math.min(q, position.upper), branch);
        range += `${range ? "L" : "M"}${a.x.toFixed(1)} ${a.y.toFixed(1)} `;
      }
    }
    this.element.querySelector("#positionRange").setAttribute("d", range);
    let alternativeRange = "";
    if (available && !firm) {
      for (let q = position.lower; q <= position.upper + 0.005; q += 0.01) {
        const a = this.point(Math.min(q, position.upper), otherBranch);
        alternativeRange += `${alternativeRange ? "L" : "M"}${a.x.toFixed(1)} ${a.y.toFixed(1)} `;
      }
    }
    this.element
      .querySelector("#alternativeRange")
      .setAttribute("d", alternativeRange);
    this.element.setAttribute(
      "aria-label",
      available
        ? `Illustrative track. Relative movement progress approximately ${Math.round(p * 100)} percent, uncertain from ${Math.round(position.lower * 100)} to ${Math.round(position.upper * 100)} percent. Junction location unmeasured.`
        : "Illustrative route. Waiting for sensor-derived position. Junction location unmeasured.",
    );
  }
}
