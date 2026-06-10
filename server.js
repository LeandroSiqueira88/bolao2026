const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── BANCO DE DADOS ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── ANTHROPIC ──────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── SETUP DO BANCO (roda na inicialização) ─────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participantes (
      id          SERIAL PRIMARY KEY,
      nome        TEXT NOT NULL,
      whatsapp    TEXT NOT NULL,
      brasil      TEXT NOT NULL,
      neymar      TEXT NOT NULL,
      neymar_gols INTEGER DEFAULT 0,
      finalista1  TEXT NOT NULL,
      finalista2  TEXT NOT NULL,
      finalista3  TEXT NOT NULL,
      finalista4  TEXT NOT NULL,
      quarto      TEXT NOT NULL,
      terceiro    TEXT NOT NULL,
      vice        TEXT NOT NULL,
      campeao     TEXT NOT NULL,
      pago        BOOLEAN DEFAULT FALSE,
      pontos      INTEGER DEFAULT 0,
      criado_em   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resultados (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      brasil      TEXT DEFAULT '',
      neymar      TEXT DEFAULT '',
      finalista1  TEXT DEFAULT '',
      finalista2  TEXT DEFAULT '',
      finalista3  TEXT DEFAULT '',
      finalista4  TEXT DEFAULT '',
      quarto      TEXT DEFAULT '',
      terceiro    TEXT DEFAULT '',
      vice        TEXT DEFAULT '',
      campeao     TEXT DEFAULT '',
      neymar_gols INTEGER DEFAULT 0,
      fase        TEXT DEFAULT 'Grupos',
      atualizado  TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO resultados (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS analises_diarias (
      id          SERIAL PRIMARY KEY,
      data_jogo   DATE NOT NULL,
      fase        TEXT NOT NULL DEFAULT 'Grupos',
      jogos       TEXT NOT NULL,
      analise     TEXT NOT NULL,
      criado_em   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── MIGRATIONS: adiciona colunas novas sem quebrar banco existente ──────
  const migrations = [
    `ALTER TABLE participantes ADD COLUMN IF NOT EXISTS neymar_gols INTEGER DEFAULT 0`,
    `ALTER TABLE resultados    ADD COLUMN IF NOT EXISTS neymar_gols INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS analises_diarias (
      id SERIAL PRIMARY KEY,
      data_jogo DATE NOT NULL,
      fase TEXT NOT NULL DEFAULT 'Grupos',
      jogos TEXT NOT NULL,
      analise TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { console.warn('Migration skip:', e.message); }
  }

  console.log('✅ Banco de dados pronto');
}

// ── UTILS ──────────────────────────────────────────────────
function norm(s) {
  return (s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function calcPontos(p, r) {
  let pts = 0;
  const breakdown = [];

  if (r.brasil && p.brasil === r.brasil) {
    pts += 10; breakdown.push('✅ Brasil finalista: +10');
  } else if (r.brasil) {
    breakdown.push('❌ Brasil finalista: 0');
  }

  if (r.neymar && p.neymar === r.neymar) {
    pts += 10; breakdown.push('✅ Neymar gol: +10');
    // Bônus: acertou a quantidade exata (dinâmico — atualiza conforme admin muda o número)
    if (r.neymar_gols > 0) {
      if (parseInt(p.neymar_gols) === parseInt(r.neymar_gols)) {
        pts += 20;
        breakdown.push(`🎯 Gols exatos (${r.neymar_gols} gols): +20 bônus!`);
      } else if (p.neymar === 'Sim') {
        breakdown.push(`❌ Gols: apostou ${p.neymar_gols}, Neymar fez ${r.neymar_gols}: 0 bônus`);
      }
    }
  } else if (r.neymar) {
    breakdown.push('❌ Neymar gol: 0');
  }

  const rf = [r.finalista1, r.finalista2, r.finalista3, r.finalista4]
    .map(norm).filter(Boolean);
  if (rf.length) {
    let ac = 0;
    [p.finalista1, p.finalista2, p.finalista3, p.finalista4].forEach(f => {
      if (rf.includes(norm(f))) ac++;
    });
    pts += ac * 10;
    breakdown.push(ac > 0 ? `✅ Finalistas (${ac}x): +${ac * 10}` : '❌ Finalistas: 0');
  }

  if (r.quarto && norm(p.quarto) === norm(r.quarto)) {
    pts += 10; breakdown.push('✅ 4º colocado: +10');
  } else if (r.quarto) breakdown.push('❌ 4º colocado: 0');

  if (r.terceiro && norm(p.terceiro) === norm(r.terceiro)) {
    pts += 20; breakdown.push('✅ 3º colocado: +20');
  } else if (r.terceiro) breakdown.push('❌ 3º colocado: 0');

  if (r.vice && norm(p.vice) === norm(r.vice)) {
    pts += 35; breakdown.push('✅ Vice-campeão: +35');
  } else if (r.vice) breakdown.push('❌ Vice-campeão: 0');

  if (r.campeao) {
    if (norm(p.campeao) === norm(r.campeao)) {
      if (norm(r.campeao) === 'brasil') {
        pts += 100; breakdown.push('🇧🇷 Brasil campeão BÔNUS: +100!');
      } else {
        pts += 50; breakdown.push('✅ Campeão: +50');
      }
    } else breakdown.push('❌ Campeão: 0');
  }

  return { pts, breakdown };
}

// ══════════════════════════════════════════════════════════
// ROTAS DA API
// ══════════════════════════════════════════════════════════

// ── POST /api/participantes — Inscrição ───────────────────
app.post('/api/participantes', upload.single('comprovante'), async (req, res) => {
  try {
    const { nome, whatsapp, brasil, neymar, neymar_gols, finalista1, finalista2,
            finalista3, finalista4, quarto, terceiro, vice, campeao } = req.body;

    if (!nome || !whatsapp || !brasil || !neymar ||
        !finalista1 || !finalista2 || !finalista3 || !finalista4 ||
        !quarto || !terceiro || !vice || !campeao) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    // neymar_gols só tem sentido se neymar=Sim
    const golsVal = (neymar === 'Sim') ? (parseInt(neymar_gols) || 0) : 0;

    const result = await pool.query(
      `INSERT INTO participantes
        (nome, whatsapp, brasil, neymar, neymar_gols, finalista1, finalista2, finalista3, finalista4, quarto, terceiro, vice, campeao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, nome, criado_em`,
      [nome, whatsapp, brasil, neymar, golsVal,
       norm(finalista1), norm(finalista2), norm(finalista3), norm(finalista4),
       norm(quarto), norm(terceiro), norm(vice), norm(campeao)]
    );

    res.json({ ok: true, participante: result.rows[0] });
  } catch (err) {
    console.error('Erro ao salvar inscrição:', err.message, err.detail || '');
    res.status(500).json({ error: 'Erro ao salvar inscrição: ' + err.message });
  }
});

// ── GET /api/ranking — Ranking público (só pagos) ─────────
app.get('/api/ranking', async (req, res) => {
  try {
    const { rows: participantes } = await pool.query(
      'SELECT * FROM participantes WHERE pago = TRUE ORDER BY pontos DESC, criado_em ASC'
    );
    const { rows: [resultado] } = await pool.query('SELECT * FROM resultados WHERE id = 1');
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM participantes');
    const { rows: [{ count: pagos }] } = await pool.query('SELECT COUNT(*) FROM participantes WHERE pago = TRUE');

    res.json({ participantes, resultado, total: parseInt(count), pagos: parseInt(pagos) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/participantes — Todos (admin) ──────────
app.get('/api/admin/participantes', verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM participantes ORDER BY criado_em ASC');
    const { rows: [resultado] } = await pool.query('SELECT * FROM resultados WHERE id = 1');
    res.json({ participantes: rows, resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/participantes/:id — Confirmar pago ───
app.patch('/api/admin/participantes/:id', verificarAdmin, async (req, res) => {
  try {
    const { pago } = req.body;
    await pool.query('UPDATE participantes SET pago = $1 WHERE id = $2', [pago, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/participantes/:id — Remover ─────────
app.delete('/api/admin/participantes/:id', verificarAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM participantes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/resultados — Salvar resultados ─────────
app.put('/api/admin/resultados', verificarAdmin, async (req, res) => {
  try {
    const { brasil, neymar, finalista1, finalista2, finalista3, finalista4,
            quarto, terceiro, vice, campeao, fase } = req.body;

    const ng = parseInt(req.body.neymar_gols)||0;
    await pool.query(
      `UPDATE resultados SET
        brasil=$1, neymar=$2, finalista1=$3, finalista2=$4,
        finalista3=$5, finalista4=$6, quarto=$7, terceiro=$8,
        vice=$9, campeao=$10, fase=$11, neymar_gols=$12, atualizado=NOW()
       WHERE id=1`,
      [brasil, neymar, finalista1, finalista2, finalista3, finalista4,
       quarto, terceiro, vice, campeao, fase, ng]
    );

    // Recalcula pontos de todos os participantes pagos
    const { rows: participantes } = await pool.query('SELECT * FROM participantes WHERE pago = TRUE');
    const r = { brasil, neymar, neymar_gols: parseInt(req.body.neymar_gols)||0, finalista1, finalista2, finalista3, finalista4, quarto, terceiro, vice, campeao };

    for (const p of participantes) {
      const { pts } = calcPontos(p, r);
      await pool.query('UPDATE participantes SET pontos = $1 WHERE id = $2', [pts, p.id]);
    }

    res.json({ ok: true, atualizados: participantes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/calcular-ia — Agente IA ───────────────
app.post('/api/admin/calcular-ia', verificarAdmin, async (req, res) => {
  try {
    const { rows: participantes } = await pool.query(
      'SELECT * FROM participantes WHERE pago = TRUE ORDER BY pontos DESC'
    );
    const { rows: [r] } = await pool.query('SELECT * FROM resultados WHERE id = 1');

    if (participantes.length === 0) {
      return res.json({ analise: 'Nenhum participante confirmado para analisar ainda.' });
    }

    const linhas = participantes.map((p, i) => {
      const { pts, breakdown } = calcPontos(p, r);
      return `${i + 1}. ${p.nome} (${pts} pts)\n   Palpites: Brasil=${p.brasil}, Neymar=${p.neymar}, Finalistas=[${[p.finalista1,p.finalista2,p.finalista3,p.finalista4].join(', ')}], 4º=${p.quarto}, 3º=${p.terceiro}, Vice=${p.vice}, Campeão=${p.campeao}\n   Detalhes: ${breakdown.join(' | ')}`;
    }).join('\n\n');

    const prompt = `Você é o agente oficial do Bolão Entre Amigos 2026 (Copa do Mundo).

RESULTADOS OFICIAIS — Fase: ${r.fase || 'Aguardando início'}
Brasil entre 8 finalistas: ${r.brasil || 'aguardando'}
Neymar marcou gol: ${r.neymar || 'aguardando'} | Qtd gols: ${r.neymar_gols || '?'}
Finalistas: ${[r.finalista1, r.finalista2, r.finalista3, r.finalista4].filter(Boolean).join(', ') || 'aguardando'}
4º Colocado: ${r.quarto || '?'} | 3º Colocado: ${r.terceiro || '?'}
Vice-Campeão: ${r.vice || '?'} | Campeão: ${r.campeao || '?'}

PALPITES E PONTUAÇÕES:
${linhas}

TABELA DE PONTUAÇÃO:
Brasil/Neymar = 10 pts cada | Bônus gols Neymar (qtd exata) = +20 pts | Cada finalista = 10 pts | 4º = 10 pts | 3º = 20 pts | Vice = 35 pts | Campeão = 50 pts | Brasil campeão (bônus) = 100 pts
OBS: O bônus de gols do Neymar é dinâmico — atualiza conforme o admin registra os gols reais.

Faça uma análise completa, animada e bem-humorada em português do Brasil. Para cada participante explique brevemente o que acertou e errou. Mostre o ranking atual em ordem. Termine com uma previsão empolgante do que pode ainda mudar no bolão. Use emojis, seja direto e divertido!`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const analise = message.content[0].text;
    res.json({ analise });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao chamar agente de IA: ' + err.message });
  }
});

// ── POST /api/auth — Verificar senha admin ────────────────
app.post('/api/auth', (req, res) => {
  const { senha } = req.body;
  if (senha === process.env.ADMIN_PASSWORD) {
    res.json({ ok: true, token: Buffer.from(senha).toString('base64') });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ── MIDDLEWARE: verificar admin ────────────────────────────
function verificarAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    if (decoded === process.env.ADMIN_PASSWORD) return next();
  } catch {}
  res.status(401).json({ error: 'Não autorizado' });
}


// ── GET /api/analises — Histórico público ────────────────
app.get('/api/analises', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM analises_diarias ORDER BY data_jogo DESC, criado_em DESC LIMIT 30'
    );
    res.json({ analises: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/analise-dia — Gerar análise do dia ───
app.post('/api/admin/analise-dia', verificarAdmin, async (req, res) => {
  try {
    const { data_jogo, fase, jogos, proximo_dia } = req.body;
    if (!jogos || !jogos.trim()) {
      return res.status(400).json({ error: 'Informe os jogos do dia.' });
    }

    // Busca participantes pagos para cruzar com os palpites
    const { rows: participantes } = await pool.query(
      'SELECT * FROM participantes WHERE pago = TRUE ORDER BY pontos DESC'
    );
    const { rows: [resultado] } = await pool.query('SELECT * FROM resultados WHERE id = 1');

    const rankingInfo = participantes.length
      ? participantes.map((p, i) =>
          (i+1) + '. ' + p.nome + ' (' + p.pontos + ' pts) — Campeão: ' + p.campeao
        ).join('\n')
      : 'Nenhum participante confirmado ainda.';

    const prompt = `Você é o jornalista e comentarista oficial do Bolão Entre Amigos 2026.

DATA: ${data_jogo}
FASE DA COPA: ${fase}

JOGOS DO DIA:
${jogos}

RANKING ATUAL DO BOLÃO:
${rankingInfo}

${proximo_dia ? 'JOGOS DO PRÓXIMO DIA (prévia):\n' + proximo_dia : ''}

Escreva uma análise completa, animada e bem-humorada em português do Brasil com:

1. 📰 RESUMO DOS JOGOS — Conte como foram as partidas, destaques, gols, surpresas
2. 🏆 IMPACTO NO BOLÃO — Analise como os resultados afetam os palpites dos participantes. Quem ganhou pontos? Quem perdeu chances? Quem está se destacando?
3. 🔥 DESTAQUE DO DIA — Eleja o jogador ou momento mais marcante
4. 🔮 PREVISÃO — O que esperar nos próximos jogos? Quem pode virar o bolão?

Use emojis, seja empolgante, engraçado e apaixonado pelo futebol. Escreva como se fosse um post animado para o grupo do WhatsApp!`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const analise = message.content[0].text;

    // Salva no banco
    await pool.query(
      'INSERT INTO analises_diarias (data_jogo, fase, jogos, analise) VALUES ($1, $2, $3, $4)',
      [data_jogo, fase, jogos, analise]
    );

    res.json({ ok: true, analise });
  } catch (err) {
    console.error('Erro análise dia:', err);
    res.status(500).json({ error: 'Erro ao gerar análise: ' + err.message });
  }
});

// ── DELETE /api/admin/analise-dia/:id — Deletar análise ──
app.delete('/api/admin/analise-dia/:id', verificarAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM analises_diarias WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback: serve o frontend ─────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao iniciar banco:', err);
  process.exit(1);
});
