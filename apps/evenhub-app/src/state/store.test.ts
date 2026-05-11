import { describe, expect, it, vi } from 'vitest'

import { createStore } from './store.js'

interface CountState {
  n: number
}
type CountAction = { type: 'inc' } | { type: 'add'; by: number } | { type: 'noop' }

function countReducer(state: CountState, action: CountAction): CountState {
  switch (action.type) {
    case 'inc':
      return { n: state.n + 1 }
    case 'add':
      return { n: state.n + action.by }
    case 'noop':
      return state
  }
}

describe('createStore', () => {
  it('returns initial state via getState', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    expect(store.getState()).toEqual({ n: 0 })
  })

  it('reduces on dispatch and exposes the new state', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    store.dispatch({ type: 'inc' })
    expect(store.getState()).toEqual({ n: 1 })
    store.dispatch({ type: 'add', by: 5 })
    expect(store.getState()).toEqual({ n: 6 })
  })

  it('notifies all subscribers with the new state', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    const a = vi.fn<(s: CountState) => void>()
    const b = vi.fn<(s: CountState) => void>()
    store.subscribe(a)
    store.subscribe(b)
    store.dispatch({ type: 'inc' })
    expect(a).toHaveBeenCalledWith({ n: 1 })
    expect(b).toHaveBeenCalledWith({ n: 1 })
  })

  it('skips notification when reducer returns the same reference', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    const fn = vi.fn<(s: CountState) => void>()
    store.subscribe(fn)
    store.dispatch({ type: 'noop' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('unsubscribes via the returned function', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    const fn = vi.fn<(s: CountState) => void>()
    const off = store.subscribe(fn)
    off()
    store.dispatch({ type: 'inc' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('survives a listener that throws — others still fire', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    const evil = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn<(s: CountState) => void>()
    store.subscribe(evil)
    store.subscribe(good)
    expect(() => {
      store.dispatch({ type: 'inc' })
    }).not.toThrow()
    expect(good).toHaveBeenCalled()
  })

  it('unsubscribe is idempotent', () => {
    const store = createStore<CountState, CountAction>(countReducer, { n: 0 })
    const fn = vi.fn<(s: CountState) => void>()
    const off = store.subscribe(fn)
    off()
    off()
    store.dispatch({ type: 'inc' })
    expect(fn).not.toHaveBeenCalled()
  })
})
