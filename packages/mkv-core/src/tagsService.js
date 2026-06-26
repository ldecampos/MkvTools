const fs = require('fs');
const os = require('os');
const path = require('path');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Write a Matroska tags XML file with IMDb/TMDb identifiers (Jellyfin reads these).
// Returns the temp file path; caller is responsible for deleting it after use.
function writeTagsFile(movie) {
  const simpleTags = [];
  if (movie.imdbId) simpleTags.push(`    <Simple><Name>IMDB</Name><String>${escapeXml(movie.imdbId)}</String></Simple>`);
  const tmdbType = movie.type === 'series' ? 'tv' : 'movie';
  if (movie.id) simpleTags.push(`    <Simple><Name>TMDB</Name><String>${tmdbType}/${escapeXml(String(movie.id))}</String></Simple>`);
  if (movie.title) simpleTags.push(`    <Simple><Name>TITLE</Name><String>${escapeXml(movie.title)}</String></Simple>`);
  if (movie.year) simpleTags.push(`    <Simple><Name>DATE_RELEASED</Name><String>${escapeXml(movie.year)}</String></Simple>`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Tags>
  <Tag>
    <Targets><TargetTypeValue>50</TargetTypeValue></Targets>
${simpleTags.join('\n')}
  </Tag>
</Tags>`;

  const tmpPath = path.join(os.tmpdir(), `mkvtools-tags-${Date.now()}.xml`);
  fs.writeFileSync(tmpPath, xml, 'utf8');
  return tmpPath;
}

module.exports = { writeTagsFile, escapeXml };
