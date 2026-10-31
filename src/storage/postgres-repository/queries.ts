const passageSelect = `c.id::text,c.ordinal,c.indexed_at AS "indexedAt",s.id::text AS "sourceId",v.id::text AS "versionId",s.url,s.title,c.excerpt,v.game,v.game_version AS "gameVersion",v.language,s.added_at AS "addedAt",v.fetched_at AS "fetchedAt",v.last_checked_at AS "lastCheckedAt",v.published_at AS "publishedAt",v.source_updated_at AS "sourceUpdatedAt"`

const currentVersionJoins =
  'FROM knowledge_chunks c JOIN knowledge_versions v ON v.id=c.version_id JOIN knowledge_sources s ON s.id=v.source_id AND s.current_version=v.id'

function queryFilters(filter?: { game?: string; gameVersion?: string | null; language?: string }) {
  const values: unknown[] = []
  const filters: string[] = []
  for (const [field, value] of [
    ['lower(v.game)', filter?.game?.toLowerCase()],
    ['v.game_version', filter?.gameVersion],
    ['v.language', filter?.language],
  ]) {
    if (value === null) filters.push(`${field} IS NULL`)
    else if (value !== undefined) {
      values.push(value)
      filters.push(`${field}=$${values.length}`)
    }
  }
  return { values, filters }
}

export function knowledgeQueries(
  query: string,
  vector: string,
  space: string,
  dimensions: number,
  limit: number,
  filter?: { game?: string; gameVersion?: string | null; language?: string },
  ann = false,
) {
  const { values, filters } = queryFilters(filter)
  const argument = values.length + 1
  const where = filters.length ? filters.join(' AND ') : 'TRUE'
  const denseValues = [...values, space, dimensions, vector, limit]
  const distance = ann
    ? `(c.embedding::public.halfvec(${dimensions})) OPERATOR(public.<=>) $${argument + 2}::public.halfvec(${dimensions})`
    : `c.embedding OPERATOR(public.<=>) $${argument + 2}::public.vector`
  const textValues = [...values, query, limit]
  return [
    {
      sql: `SELECT ${passageSelect},1-(${distance}) AS score ${currentVersionJoins}
      WHERE ${where} AND c.space=$${argument} AND c.dimensions=$${argument + 1}
      ORDER BY ${distance} LIMIT $${argument + 3}`,
      values: denseValues,
    },
    {
      // FTS deliberately covers every stored embedding space during migration.
      // Collapse version/ordinal duplicates before ranking, rather than allowing
      // duplicate spaces to consume the candidate budget.
      sql: `WITH lexical AS (SELECT DISTINCT ON(c.version_id,c.ordinal) ${passageSelect},
        ts_rank_cd(c.terms,plainto_tsquery('simple',$${argument})) AS score ${currentVersionJoins}
        WHERE ${where} AND c.terms@@plainto_tsquery('simple',$${argument})
        ORDER BY c.version_id,c.ordinal,(c.space=$${argument + 2}) DESC,c.id)
        SELECT * FROM lexical ORDER BY score DESC,id LIMIT $${argument + 1}`,
      values: [...textValues, space],
    },
  ]
}
