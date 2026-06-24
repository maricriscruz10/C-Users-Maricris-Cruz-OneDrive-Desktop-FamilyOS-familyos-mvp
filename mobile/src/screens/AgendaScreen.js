import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { Api } from '../api';
import { Cache } from '../storage';
import { colors, statusBadgeColor } from '../theme';

export default function AgendaScreen({ user, family, onOpenEvent, onAddEvent }) {
  const [events, setEvents] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  const load = useCallback(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(Date.now() + 14 * 86400000);
    try {
      const r = await Api.events(user.familyId, start.toISOString(), end.toISOString());
      setEvents(r.events);
      setFromCache(false);
      await Cache.setEvents(r.events);
    } catch {
      const cached = await Cache.getEvents();
      setEvents(cached);
      setFromCache(true);
    }
  }, [user.familyId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const grouped = groupByDay(events);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Agenda</Text>
          <Text style={styles.subtitle}>{family?.name}{fromCache ? ' · showing cached data (offline)' : ''}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={onAddEvent}>
          <Text style={styles.addBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={grouped}
        keyExtractor={(item) => item.dateKey}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={<Text style={styles.empty}>No events in the next two weeks.</Text>}
        renderItem={({ item }) => (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.dayLabel}>{item.label}</Text>
            {item.events.map((e) => (
              <TouchableOpacity key={e.id} style={styles.card} onPress={() => onOpenEvent(e)}>
                <Text style={styles.time}>{new Date(e.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.eventTitle}>{e.title}</Text>
                  {e.location ? <Text style={styles.meta}>📍 {e.location}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {e.assignees.map((a) => {
                      const b = statusBadgeColor(a.status);
                      return (
                        <View key={a.userId} style={[styles.badge, { backgroundColor: b.bg }]}>
                          <Text style={[styles.badgeText, { color: b.text }]}>{a.name.split(' ')[0]} · {a.status}</Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      />
    </View>
  );
}

function groupByDay(events) {
  const map = new Map();
  events.forEach((e) => {
    const d = new Date(e.startAt);
    const key = d.toDateString();
    if (!map.has(key)) map.set(key, { dateKey: key, label: d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), events: [] });
    map.get(key).events.push(e);
  });
  return [...map.values()];
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted },
  addBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: 'white', fontWeight: '700', fontSize: 13 },
  dayLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: 8 },
  card: { flexDirection: 'row', gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  time: { width: 60, fontSize: 12, fontWeight: '700', color: colors.muted },
  eventTitle: { fontWeight: '700', fontSize: 14, color: colors.text },
  meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 40 },
});
