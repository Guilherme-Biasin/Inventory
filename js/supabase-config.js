// ═══════════════════════════════════════════════════════════════
//  supabase-config.js  —  Conexão e todas as operações com o banco
//  ⚠️  Substitua as 2 variáveis abaixo pelas suas do Supabase
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL    = 'COLE_SUA_URL_AQUI';       // ex: https://xyzxyz.supabase.co
const SUPABASE_ANON   = 'COLE_SUA_ANON_KEY_AQUI';  // chave pública (anon key)

// ── Carrega o cliente Supabase (importado via CDN no index.html)
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ═══════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════
const Auth = {
  // Login com email + senha
  async login(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },

  // Logout
  async logout() {
    await _sb.auth.signOut();
  },

  // Retorna usuário logado ou null
  async getUser() {
    const { data } = await _sb.auth.getUser();
    return data?.user || null;
  },

  // Observa mudanças de sessão
  onAuthChange(callback) {
    _sb.auth.onAuthStateChange((_event, session) => {
      callback(session?.user || null);
    });
  }
};

// ═══════════════════════════════════════════════════════════════
//  CONFIG (categorias, locais, status, vínculos)
// ═══════════════════════════════════════════════════════════════
const DB = {

  async loadConfig() {
    const { data, error } = await _sb
      .from('config')
      .select('*')
      .eq('id', 'main')
      .single();
    if (error) throw error;
    return {
      cats:       data.cats        || [],
      pessoas:    data.pessoas     || [],
      locais:     data.locais      || [],
      statusOpts: data.status_opts || [],
      vinculos:   data.vinculos    || { entrada: { statusIds:[], localIds:[] }, saida: { statusIds:[], localIds:[] } }
    };
  },

  async saveConfig(cfg) {
    const { error } = await _sb
      .from('config')
      .update({
        cats:        cfg.cats,
        pessoas:     cfg.pessoas,
        locais:      cfg.locais,
        status_opts: cfg.statusOpts,
        vinculos:    cfg.vinculos,
        updated_at:  new Date().toISOString()
      })
      .eq('id', 'main');
    if (error) throw error;
  },

  // ═══════════════════════════════════════════════════════════
  //  PATRIMÔNIOS
  // ═══════════════════════════════════════════════════════════

  // Carrega todos os patrimônios com histórico
  async loadItems() {
    const { data: pats, error } = await _sb
      .from('patrimonios')
      .select('*, movimentacoes(*)')
      .order('id', { ascending: true });
    if (error) throw error;

    return pats.map(p => ({
      id:           p.id,
      patrimonio:   p.patrimonio,
      nome:         p.nome,
      serie:        p.serie,
      categoria:    p.categoria ? [p.categoria] : [],
      status:       p.status    ? [p.status]    : [],
      local_atual:  p.local_atual  || '',
      usuario_atual: p.usuario_atual || '',
      historico:    (p.movimentacoes || [])
                      .sort((a,b) => new Date(a.created_at) - new Date(b.created_at))
                      .map(m => ({
                        timestamp:             m.created_at,
                        tipo:                  m.tipo,
                        data_mov:              m.data_mov,
                        quem_recebeu_retirou:  m.quem_recebeu_retirou,
                        usuario_atual:         m.usuario_atual,
                        local:                 m.local,
                        obs_mov:               m.obs_mov
                      }))
    }));
  },

  // Cria novo patrimônio + primeira movimentação
  async createItem(item, mov) {
    const user = await Auth.getUser();

    const { data: pat, error: pe } = await _sb
      .from('patrimonios')
      .insert({
        patrimonio:    item.patrimonio,
        nome:          item.nome,
        serie:         item.serie,
        categoria:     item.categoria?.[0] || null,
        status:        item.status?.[0]    || null,
        local_atual:   mov.local || '',
        usuario_atual: mov.usuario_atual || '',
        created_by:    user?.id
      })
      .select()
      .single();
    if (pe) throw pe;

    if (mov.data_mov || mov.quem_recebeu_retirou || mov.obs_mov || mov.local) {
      const { error: me } = await _sb.from('movimentacoes').insert({
        patrimonio_id:        pat.id,
        tipo:                 'entrada',
        data_mov:             mov.data_mov              || null,
        quem_recebeu_retirou: mov.quem_recebeu_retirou  || null,
        usuario_atual:        mov.usuario_atual          || null,
        local:                mov.local                  || null,
        obs_mov:              mov.obs_mov                || null,
        created_by:           user?.id
      });
      if (me) throw me;
    }

    return pat.id;
  },

  // Atualiza dados fixos do patrimônio
  async updateItem(id, item) {
    const { error } = await _sb
      .from('patrimonios')
      .update({
        patrimonio:  item.patrimonio,
        nome:        item.nome,
        serie:       item.serie,
        categoria:   item.categoria?.[0] || null,
        status:      item.status?.[0]    || null
      })
      .eq('id', id);
    if (error) throw error;
  },

  // Registra nova movimentação + atualiza local/usuário no patrimônio
  async registrarMovimentacao(patrimonioId, mov) {
    const user = await Auth.getUser();

    const { error: me } = await _sb.from('movimentacoes').insert({
      patrimonio_id:        patrimonioId,
      tipo:                 'movimentacao',
      data_mov:             mov.data_mov              || null,
      quem_recebeu_retirou: mov.quem_recebeu_retirou  || null,
      usuario_atual:        mov.usuario_atual          || null,
      local:                mov.local                  || null,
      obs_mov:              mov.obs_mov                || null,
      created_by:           user?.id
    });
    if (me) throw me;

    // Atualiza local e usuário atual no patrimônio
    const upd = {};
    if (mov.local)         upd.local_atual   = mov.local;
    if (mov.usuario_atual) upd.usuario_atual = mov.usuario_atual;
    if (mov.status)        upd.status        = mov.status;
    if (Object.keys(upd).length) {
      await _sb.from('patrimonios').update(upd).eq('id', patrimonioId);
    }
  },

  // Deleta patrimônio (histórico é deletado em cascata)
  async deleteItem(id) {
    const { error } = await _sb.from('patrimonios').delete().eq('id', id);
    if (error) throw error;
  },

  // ── Realtime: recebe callback quando qualquer patrimônio mudar
  subscribeItems(callback) {
    return _sb
      .channel('patrimonios_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patrimonios' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movimentacoes' }, callback)
      .subscribe();
  },

  // ── AUDITORIA ────────────────────────────────────────────────
  async loadAuditoria(limit = 200) {
    const { data, error } = await _sb
      .from('auditoria')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async loadAuditoriaItem(patrimonioId) {
    const { data, error } = await _sb
      .from('auditoria')
      .select('*')
      .eq('registro_id', String(patrimonioId))
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  subscribeAuditoria(callback) {
    return _sb
      .channel('auditoria_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'auditoria' }, callback)
      .subscribe();
  }
};