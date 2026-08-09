export function normalizeCoberturaXml(xml) {
  return String(xml)
    .replace(/ timestamp="[^"]*"/, ' timestamp="0"')
    .replace(/<sources>[\s\S]*?<\/sources>/, '<sources>\n    <source>.</source>\n  </sources>');
}
