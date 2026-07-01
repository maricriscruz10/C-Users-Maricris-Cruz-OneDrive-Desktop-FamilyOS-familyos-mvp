import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Modal, TextInput, ScrollView, Alert } from 'react-native';
import { Api } from '../api';
import { colors } from '../theme';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

export default function MealsScreen({ user, familyId, members }) {
  const [meals, setMeals] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const canManage = user.role !== 'child';

  const load = useCallback(async () => {
    const start = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10);
    try {
      const r = await Api.meals(familyId, start, end);
      setMeals(r.meals);
    } catch (e) {
      Alert.alert('Could not load meal plan', e.message);
    }
  }, [familyId]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const grouped = groupByDate(meals);
  const cookName = (id) => { const m = members.find((x) => x.id === id); return m ? m.name.split(' ')[0] : 'Unassigned'; };
  const totalCals = meals.reduce((s, m) => s + (m.calories || 0), 0);

  const remove = (id) => Alert.alert('Delete meal?', '', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { await Api.deleteMeal(id); load(); } },
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Meal Plan</Text>
          <Text style={styles.subtitle}>
            {meals.length} meal{meals.length === 1 ? '' : 's'}{totalCals > 0 ? ` · ~${totalCals.toLocaleString()} cal total` : ''}
          </Text>
        </View>
        {canManage && (
          <TouchableOpacity style={styles.addBtn} onPress={() => setModalOpen(true)}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
        )}
      </View>
      <FlatList
        data={grouped}
        keyExtractor={(item) => item.dateKey}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={<Text style={styles.empty}>No meals planned yet.</Text>}
        renderItem={({ item }) => {
          const dayCals = item.meals.reduce((s, m) => s + (m.calories || 0), 0);
          return (
            <View style={{ marginBottom: 16 }}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayLabel}>{item.label}</Text>
                {dayCals > 0 && <Text style={styles.dayCals}>🔥 {dayCals.toLocaleString()} cal</Text>}
              </View>
              {item.meals.map((m) => (
                <View key={m.id} style={styles.card}>
                  <View style={styles.mealTypeBadge}><Text style={styles.mealTypeText}>{m.mealType}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mealTitle}>{m.title}</Text>
                    <Text style={styles.meta}>
                      {m.notes ? m.notes + ' · ' : ''}👨‍🍳 {cookName(m.assignedCook)}{m.calories ? ` · 🔥 ${m.calories} cal` : ''}
                    </Text>
                  </View>
                  {canManage && (
                    <TouchableOpacity onPress={() => remove(m.id)}><Text style={styles.deleteText}>✕</Text></TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          );
        }}
      />
      <MealModal visible={modalOpen} members={members} familyId={familyId}
        onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); load(); }} />
    </View>
  );
}

function groupByDate(meals) {
  const map = new Map();
  meals.forEach((m) => {
    const key = m.mealDate;
    if (!map.has(key)) {
      map.set(key, { dateKey: key, label: new Date(key + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), meals: [] });
    }
    map.get(key).meals.push(m);
  });
  return [...map.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

function MealModal({ visible, members, familyId, onClose, onSaved }) {
  const [mealDate, setMealDate] = useState(new Date().toISOString().slice(0, 10));
  const [mealType, setMealType] = useState('dinner');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [calories, setCalories] = useState('');
  const [assignedCook, setAssignedCook] = useState(null);

  const save = async () => {
    if (!title.trim()) return Alert.alert('Title required');
    try {
      await Api.createMeal(familyId, { mealDate, mealType, title, notes, calories: Number(calories) || 0, assignedCook });
      setTitle(''); setNotes(''); setCalories('');
      onSaved();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 56 }}>
        <Text style={styles.heading}>Add a meal</Text>
        <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
        <TextInput style={styles.input} value={mealDate} onChangeText={setMealDate} placeholder="2026-07-02" />
        <Text style={styles.label}>Meal</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          {MEAL_TYPES.map((t) => (
            <TouchableOpacity key={t} onPress={() => setMealType(t)} style={[styles.pill, mealType === t && styles.pillActive]}>
              <Text style={[styles.pillText, mealType === t && styles.pillTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Taco night" />
        <Text style={styles.label}>Notes</Text>
        <TextInput style={styles.input} value={notes} onChangeText={setNotes} placeholder="optional" />
        <Text style={styles.label}>Calories (optional)</Text>
        <TextInput style={styles.input} value={calories} onChangeText={setCalories} keyboardType="number-pad" placeholder="e.g. 450" />
        <Text style={styles.label}>Assigned cook</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <TouchableOpacity onPress={() => setAssignedCook(null)} style={[styles.pill, !assignedCook && styles.pillActive]}>
            <Text style={[styles.pillText, !assignedCook && styles.pillTextActive]}>None</Text>
          </TouchableOpacity>
          {members.map((m) => (
            <TouchableOpacity key={m.id} onPress={() => setAssignedCook(m.id)} style={[styles.pill, assignedCook === m.id && styles.pillActive]}>
              <Text style={[styles.pillText, assignedCook === m.id && styles.pillTextActive]}>{m.name.split(' ')[0]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, flex: 0 }]} onPress={onClose}>
            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, flex: 1 }]} onPress={save}>
            <Text style={styles.btnText}>Save</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted },
  addBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: 'white', fontWeight: '700', fontSize: 13 },
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  dayLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase' },
  dayCals: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  mealTypeBadge: { backgroundColor: colors.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  mealTypeText: { fontSize: 10, fontWeight: '700', color: colors.muted, textTransform: 'capitalize' },
  mealTitle: { fontWeight: '700', fontSize: 14, color: colors.text },
  meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  deleteText: { color: colors.red, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 40 },
  heading: { fontSize: 20, fontWeight: '800', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 14 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, color: colors.text },
  pillTextActive: { color: 'white', fontWeight: '700' },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', paddingHorizontal: 16 },
  btnText: { color: 'white', fontWeight: '700' },
});
