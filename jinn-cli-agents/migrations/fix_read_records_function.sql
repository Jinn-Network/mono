CREATE OR REPLACE FUNCTION public.read_records(p_table_name text, p_filter jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  allowed_tables TEXT[] := ARRAY[
    'artifacts',
    'job_board',
    'job_definitions',
    'job_schedules',
    'job_reports',
    'memories',
    'messages',
    'prompt_library',
    'threads',
    'system_state'
  ];
  query TEXT;
  result JSONB;
  where_clause TEXT := '';
  filter_key TEXT;
  filter_value TEXT;
  filter_conditions TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT p_table_name = ANY(allowed_tables) THEN
    RAISE EXCEPTION 'Table % is not in the list of allowed tables.', p_table_name;
  END IF;

  IF p_filter IS NOT NULL AND jsonb_typeof(p_filter) != 'null' AND p_filter::text != '{}'::text THEN
    FOR filter_key, filter_value IN SELECT * FROM jsonb_each_text(p_filter)
    LOOP
      -- Check if the value is a UUID and cast it if necessary
      IF filter_key = 'id' OR filter_key LIKE '%_id' THEN
        filter_conditions := array_append(filter_conditions, format('%I = %L::uuid', filter_key, filter_value));
      ELSE
        filter_conditions := array_append(filter_conditions, format('%I = %L', filter_key, filter_value));
      END IF;
    END LOOP;
    
    -- Only build the WHERE clause if there are conditions
    IF array_length(filter_conditions, 1) > 0 THEN
      where_clause := ' WHERE ' || array_to_string(filter_conditions, ' AND ');
    END IF;
  END IF;

  query := format('SELECT to_jsonb(array_agg(row_to_json(t))) FROM %I t%s', p_table_name, where_clause);
  EXECUTE query INTO result;
  
  IF result IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  
  RETURN result;
END;
$function$;
